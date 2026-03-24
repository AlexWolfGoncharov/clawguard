import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getConfig } from '../utils/config.js';
import logger from '../utils/logger.js';

const log = logger.child('budget');

export interface UsageRecord {
  id: number;
  timestamp: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  session_id: string;
  agent_name: string;
}

export interface BudgetStatus {
  used_today_usd: number;
  limit_usd: number;
  percentage: number;
  alert: boolean;
  blocked: boolean;
  session_usd: number;
  total_tokens_today: number;
}

const DB_PATH = path.join(os.homedir(), '.clawguard', 'queue.db');

const CREATE_BUDGET_TABLE = `
  CREATE TABLE IF NOT EXISTS usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT NOT NULL,
    model         TEXT NOT NULL DEFAULT 'unknown',
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd      REAL NOT NULL DEFAULT 0,
    session_id    TEXT NOT NULL DEFAULT '',
    agent_name    TEXT NOT NULL DEFAULT 'openclaw'
  );
  CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
`;

// Default model costs per 1M tokens (USD)
const DEFAULT_MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku': { input: 0.8, output: 4.0 },
  'claude-3-opus': { input: 15.0, output: 75.0 },
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
};

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.exec(CREATE_BUDGET_TABLE);
  _db.pragma('journal_mode = WAL');

  return _db;
}

export class BudgetTracker {
  private sessionId: string;
  private sessionCost = 0;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `session-${Date.now()}`;
    getDb(); // Ensure table exists
    log.info(`Budget tracker initialized (session: ${this.sessionId})`);
  }

  /**
   * Calculate USD cost for a given model and token counts.
   */
  calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const config = getConfig();
    const customCosts = config.budget.model_costs ?? {};

    // Check custom config first, then defaults
    const modelKey = Object.keys({ ...customCosts, ...DEFAULT_MODEL_COSTS }).find(
      (k) => model.toLowerCase().includes(k.toLowerCase())
    );

    const costs = customCosts[modelKey ?? ''] ?? DEFAULT_MODEL_COSTS[modelKey ?? ''] ?? {
      input: 1.0,
      output: 3.0,
    };

    return (inputTokens / 1_000_000) * costs.input + (outputTokens / 1_000_000) * costs.output;
  }

  /**
   * Record token usage.
   */
  addUsage(
    tokens: number,
    costUsd: number,
    opts: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      agentName?: string;
    } = {}
  ): void {
    const db = getDb();
    const inputTokens = opts.inputTokens ?? Math.floor(tokens * 0.6);
    const outputTokens = opts.outputTokens ?? tokens - inputTokens;
    const model = opts.model ?? 'unknown';
    const agentName = opts.agentName ?? 'openclaw';

    const stmt = db.prepare(`
      INSERT INTO usage (timestamp, model, input_tokens, output_tokens, cost_usd, session_id, agent_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      new Date().toISOString(),
      model,
      inputTokens,
      outputTokens,
      costUsd,
      this.sessionId,
      agentName
    );

    this.sessionCost += costUsd;
    log.debug(`Usage: ${tokens} tokens, $${costUsd.toFixed(4)} (${model})`);
  }

  /**
   * Get today's total spend.
   */
  getTodaySpend(): number {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const stmt = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM usage
      WHERE timestamp >= ?
    `);

    const row = stmt.get(today.toISOString()) as { total: number };
    return row.total;
  }

  /**
   * Get today's total token count.
   */
  getTodayTokens(): number {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const stmt = db.prepare(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
      FROM usage
      WHERE timestamp >= ?
    `);

    const row = stmt.get(today.toISOString()) as { total: number };
    return row.total;
  }

  /**
   * Check current budget status.
   */
  checkBudget(): BudgetStatus {
    const config = getConfig();
    const { daily_limit_usd, alert_threshold_pct, hard_stop } = config.budget;

    const usedToday = this.getTodaySpend();
    const totalTokensToday = this.getTodayTokens();
    const percentage = daily_limit_usd > 0 ? (usedToday / daily_limit_usd) * 100 : 0;
    const alert = percentage >= alert_threshold_pct;
    const blocked = hard_stop && usedToday >= daily_limit_usd;

    if (alert && !blocked) {
      log.warn(
        `Budget alert: $${usedToday.toFixed(4)} of $${daily_limit_usd} (${percentage.toFixed(1)}%)`
      );
    }

    if (blocked) {
      log.error(
        `Budget limit reached: $${usedToday.toFixed(4)} >= $${daily_limit_usd} — agent blocked`
      );
    }

    return {
      used_today_usd: usedToday,
      limit_usd: daily_limit_usd,
      percentage,
      alert,
      blocked,
      session_usd: this.sessionCost,
      total_tokens_today: totalTokensToday,
    };
  }

  /**
   * Returns true if the agent should be blocked from executing.
   */
  shouldBlock(): boolean {
    return this.checkBudget().blocked;
  }

  /**
   * Get usage history for the past N days.
   */
  getHistory(days = 7): UsageRecord[] {
    const db = getDb();
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const stmt = db.prepare(`
      SELECT * FROM usage
      WHERE timestamp >= ?
      ORDER BY timestamp DESC
    `);

    return stmt.all(since.toISOString()) as UsageRecord[];
  }

  /**
   * Get aggregated daily spend for the past N days.
   */
  getDailyBreakdown(days = 7): Array<{ date: string; cost_usd: number; tokens: number }> {
    const db = getDb();
    const since = new Date();
    since.setDate(since.getDate() - days);

    const stmt = db.prepare(`
      SELECT
        DATE(timestamp) as date,
        SUM(cost_usd) as cost_usd,
        SUM(input_tokens + output_tokens) as tokens
      FROM usage
      WHERE timestamp >= ?
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `);

    return stmt.all(since.toISOString()) as Array<{
      date: string;
      cost_usd: number;
      tokens: number;
    }>;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}

// Singleton budget tracker
let _tracker: BudgetTracker | null = null;

export function getBudgetTracker(): BudgetTracker {
  if (!_tracker) {
    _tracker = new BudgetTracker();
  }
  return _tracker;
}
