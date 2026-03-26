/**
 * ClawGuard — OpenClaw before_tool_call hook logic.
 *
 * notifyResolution() is called by web/telegram/discord handlers when the user decides.
 * Returns true if a hook was waiting (plugin mode), false if not (standalone mode).
 *
 * beforeToolCallHandler() is registered via api.registerHook("before_tool_call").
 */

import { getStagingEngine } from '../core/staging.js';
import { generateDiff } from '../core/diff.js';
import { addChange, resolveChange } from '../core/queue.js';
import { getBudgetTracker } from '../core/budget.js';
import { getConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { sendDiffNotification as sendTelegram } from '../channels/telegram.js';
import { sendDiffNotification as sendDiscord } from '../channels/discord.js';
import type { QueueEntry } from '../core/queue.js';
import type { DiffResult } from '../core/diff.js';

const log = logger.child('hook');

// ── Pending Approval Registry ─────────────────────────────────────────────────

interface PendingApproval {
  changeId: string;
  resolve: (approved: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Signal a waiting hook that the user has made a decision.
 *
 * Returns true  → hook was found and unblocked (plugin mode).
 * Returns false → no hook was waiting; caller should apply/reject directly (standalone mode).
 */
export function notifyResolution(changeId: string, approved: boolean): boolean {
  const pending = pendingApprovals.get(changeId);
  if (!pending) return false;

  if (pending.timer) clearTimeout(pending.timer);
  pendingApprovals.delete(changeId);
  pending.resolve(approved);
  return true;
}

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

async function notifyChannels(entry: QueueEntry, diff: DiffResult): Promise<void> {
  await Promise.allSettled([sendTelegram(entry, diff), sendDiscord(entry, diff)]);
}

// ── Hook types ────────────────────────────────────────────────────────────────

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface BeforeToolCallContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

// ── Hook handler ──────────────────────────────────────────────────────────────

/**
 * Registered as api.registerHook("before_tool_call", ...) in OpenClaw.
 *
 * Intercepts write/edit/exec tool calls, stages the change for diff display,
 * notifies the user via configured channels, then blocks until they decide.
 *
 * On approve → { block: false }  → OpenClaw lets the tool run (tool writes the file).
 * On reject  → { block: true  }  → OpenClaw cancels the tool call.
 */
export async function beforeToolCallHandler(
  event: BeforeToolCallEvent,
  ctx: BeforeToolCallContext,
): Promise<BeforeToolCallResult> {
  const { toolName, params } = event;
  const config = getConfig();
  const { require_approval, auto_approve_read, timeout_seconds } = config.staging;

  // Budget gate
  const tracker = getBudgetTracker();
  if (tracker.shouldBlock()) {
    log.warn(`Blocking tool ${toolName}: budget limit reached`);
    return { block: true, blockReason: 'Budget limit reached. Use /budget to check status.' };
  }

  // Only intercept tools in the approval list
  const requiresApproval = require_approval.includes(toolName);
  const isReadOp = ['read', 'list', 'search', 'get'].some((r) =>
    toolName.toLowerCase().includes(r),
  );

  if (!requiresApproval || (auto_approve_read && isReadOp)) {
    return { block: false };
  }

  // Extract file path and new content from tool arguments
  const filePath = extractFilePath(params);
  const newContent = extractContent(params);

  if (!filePath) {
    log.debug(`Tool ${toolName}: no file path arg — passthrough`);
    return { block: false };
  }

  if (newContent === null) {
    log.debug(`Tool ${toolName}: no content arg — passthrough`);
    return { block: false };
  }

  // Stage the change so we can show a diff to the user
  const staging = getStagingEngine();
  let stagedChange;
  try {
    stagedChange = staging.stage(filePath, newContent);
  } catch (err) {
    log.error(`Failed to stage change for ${filePath}:`, err);
    return {
      block: true,
      blockReason: `Staging failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Build diff and write to queue
  const diff = generateDiff(stagedChange.originalContent, stagedChange.newContent, filePath);
  const entry = addChange(stagedChange, diff, ctx.agentId ?? 'openclaw', 0);

  log.info(
    `Change ${stagedChange.id} queued: ${filePath} (+${diff.additions}/-${diff.deletions})`,
  );

  // Fire-and-forget notifications
  notifyChannels(entry, diff).catch((err) => {
    log.warn('Channel notification failed:', err);
  });

  // Block here until the user decides (or timeout fires)
  const approved = await waitForApproval(stagedChange.id, timeout_seconds);

  // Clean up staging directory — in plugin mode the tool itself writes the file if approved
  staging.reject(stagedChange.id);

  if (approved) {
    resolveChange(stagedChange.id, 'approved');
    log.info(`Change ${stagedChange.id} approved — tool will proceed`);
    return { block: false };
  } else {
    resolveChange(stagedChange.id, 'rejected');
    log.info(`Change ${stagedChange.id} rejected — tool blocked`);
    return {
      block: true,
      blockReason: `Change to ${filePath} was rejected via ClawGuard.`,
    };
  }
}

// ── Argument extraction ───────────────────────────────────────────────────────

function extractFilePath(params: Record<string, unknown>): string | null {
  const candidates = [
    params['file_path'],
    params['path'],
    params['filePath'],
    params['filename'],
    params['target'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

function extractContent(params: Record<string, unknown>): string | null {
  const candidates = [
    params['content'],
    params['new_content'],
    params['newContent'],
    params['text'],
    params['data'],
    params['patch'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string') return c;
  }
  return null;
}
