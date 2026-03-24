import { getStagingEngine } from '../core/staging.js';
import { generateDiff } from '../core/diff.js';
import { addChange } from '../core/queue.js';
import { getBudgetTracker } from '../core/budget.js';
import { getConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendDiffNotification as sendTelegram } from '../channels/telegram.js';
import { sendDiffNotification as sendDiscord } from '../channels/discord.js';
import type { QueueEntry } from '../core/queue.js';
import type { DiffResult } from '../core/diff.js';

const log = logger.child('plugin');

// ── OpenClaw Plugin Interface ─────────────────────────────────────────────────

export interface ToolExecutionContext {
  tool: string;
  args: Record<string, unknown>;
  agentName?: string;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ToolExecutionResult {
  blocked: boolean;
  reason?: string;
  changeId?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'passthrough';
}

export interface OpenClawPlugin {
  name: string;
  version: string;
  description: string;
  onBeforeToolExecution(ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
  onAfterToolExecution?(ctx: ToolExecutionContext, result: unknown): Promise<void>;
}

// ── Pending Change Registry ───────────────────────────────────────────────────

interface PendingApproval {
  changeId: string;
  resolve: (approved: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Called externally (from web/telegram/discord handlers) when a change is resolved.
 */
export function notifyResolution(changeId: string, approved: boolean): void {
  const pending = pendingApprovals.get(changeId);
  if (!pending) return;

  if (pending.timer) clearTimeout(pending.timer);
  pendingApprovals.delete(changeId);
  pending.resolve(approved);
}

/**
 * Wait for user approval of a change (with optional timeout).
 */
function waitForApproval(changeId: string, timeoutSeconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const approval: PendingApproval = { changeId, resolve };

    if (timeoutSeconds > 0) {
      approval.timer = setTimeout(() => {
        pendingApprovals.delete(changeId);
        log.warn(`Change ${changeId} auto-rejected (timeout ${timeoutSeconds}s)`);
        resolve(false);
      }, timeoutSeconds * 1000);
    }

    pendingApprovals.set(changeId, approval);
  });
}

// ── ClawGuard Plugin ──────────────────────────────────────────────────────────

async function notifyChannels(entry: QueueEntry, diff: DiffResult): Promise<void> {
  await Promise.allSettled([sendTelegram(entry, diff), sendDiscord(entry, diff)]);
}

export const ClawGuardPlugin: OpenClawPlugin = {
  name: 'clawguard',
  version: '0.1.0',
  description:
    'Intercepts file write/edit operations and requires user approval before applying changes.',

  async onBeforeToolExecution(ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const config = getConfig();
    const { require_approval, auto_approve_read, timeout_seconds } = config.staging;

    // Track token usage if provided
    if (ctx.inputTokens !== undefined || ctx.outputTokens !== undefined) {
      const tracker = getBudgetTracker();
      const inputT = ctx.inputTokens ?? 0;
      const outputT = ctx.outputTokens ?? 0;
      const cost = tracker.calculateCost('unknown', inputT, outputT);
      tracker.addUsage(inputT + outputT, cost, {
        inputTokens: inputT,
        outputTokens: outputT,
        agentName: ctx.agentName ?? 'openclaw',
      });
    }

    // Check budget
    const tracker = getBudgetTracker();
    if (tracker.shouldBlock()) {
      log.warn(`Blocking tool ${ctx.tool}: budget limit reached`);
      return {
        blocked: true,
        reason: 'Budget limit reached. Use /budget to check status.',
        status: 'rejected',
      };
    }

    // Check if this tool requires approval
    const requiresApproval = require_approval.includes(ctx.tool);
    const isReadOp = ['read', 'list', 'search', 'get'].some((r) =>
      ctx.tool.toLowerCase().includes(r)
    );

    if (!requiresApproval || (auto_approve_read && isReadOp)) {
      return { blocked: false, status: 'passthrough' };
    }

    // Extract file path and new content from tool args
    const filePath = extractFilePath(ctx);
    const newContent = extractContent(ctx);

    if (!filePath) {
      log.debug(`Tool ${ctx.tool} has no file path arg — passthrough`);
      return { blocked: false, status: 'passthrough' };
    }

    if (newContent === null) {
      log.debug(`Tool ${ctx.tool} has no content arg — passthrough`);
      return { blocked: false, status: 'passthrough' };
    }

    // Stage the change
    const staging = getStagingEngine();
    let stagedChange;

    try {
      stagedChange = staging.stage(filePath, newContent);
    } catch (err) {
      log.error(`Failed to stage change for ${filePath}:`, err);
      return {
        blocked: true,
        reason: `Staging failed: ${err instanceof Error ? err.message : String(err)}`,
        status: 'rejected',
      };
    }

    // Generate diff
    const diff = generateDiff(
      stagedChange.originalContent,
      stagedChange.newContent,
      filePath
    );

    // Add to queue
    const entry = addChange(
      stagedChange,
      diff,
      ctx.agentName ?? 'openclaw',
      0
    );

    log.info(
      `Change ${stagedChange.id} queued for approval: ${filePath} (+${diff.additions}/-${diff.deletions})`
    );

    // Notify channels (non-blocking)
    notifyChannels(entry, diff).catch((err) => {
      log.warn('Channel notification failed:', err);
    });

    // Wait for user decision
    const approved = await waitForApproval(stagedChange.id, timeout_seconds);

    if (approved) {
      log.info(`Change ${stagedChange.id} approved`);
      return {
        blocked: false,
        changeId: stagedChange.id,
        status: 'approved',
      };
    } else {
      log.info(`Change ${stagedChange.id} rejected`);
      return {
        blocked: true,
        changeId: stagedChange.id,
        reason: 'Change rejected by user via ClawGuard.',
        status: 'rejected',
      };
    }
  },

  async onAfterToolExecution(
    ctx: ToolExecutionContext,
    _result: unknown
  ): Promise<void> {
    log.debug(`Tool ${ctx.tool} executed`);
  },
};

// ── Argument Extraction ───────────────────────────────────────────────────────

function extractFilePath(ctx: ToolExecutionContext): string | null {
  const args = ctx.args;

  // Common patterns in OpenClaw / similar agents
  const candidates = [
    args['file_path'],
    args['path'],
    args['filePath'],
    args['filename'],
    args['target'],
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }

  return null;
}

function extractContent(ctx: ToolExecutionContext): string | null {
  const args = ctx.args;

  const candidates = [
    args['content'],
    args['new_content'],
    args['newContent'],
    args['text'],
    args['data'],
    args['patch'],
  ];

  for (const c of candidates) {
    if (typeof c === 'string') return c;
  }

  return null;
}

export default ClawGuardPlugin;
