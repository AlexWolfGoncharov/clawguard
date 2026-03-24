import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { DiffResult } from './diff.js';
import type { StagedChange } from './staging.js';
import logger from '../utils/logger.js';

const log = logger.child('queue');

export type ChangeStatus = 'pending' | 'approved' | 'rejected';

export interface QueueEntry {
  id: string;
  file_path: string;
  diff_text: string;
  additions: number;
  deletions: number;
  status: ChangeStatus;
  created_at: string;
  resolved_at: string | null;
  token_cost: number;
  agent_name: string;
}

const DB_PATH = path.join(os.homedir(), '.clawguard', 'queue.db');

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS changes (
    id          TEXT PRIMARY KEY,
    file_path   TEXT NOT NULL,
    diff_text   TEXT NOT NULL,
    additions   INTEGER NOT NULL DEFAULT 0,
    deletions   INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL,
    resolved_at TEXT,
    token_cost  REAL NOT NULL DEFAULT 0,
    agent_name  TEXT NOT NULL DEFAULT 'openclaw'
  );
  CREATE INDEX IF NOT EXISTS idx_status ON changes(status);
  CREATE INDEX IF NOT EXISTS idx_created_at ON changes(created_at);
`;

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.exec(CREATE_TABLE_SQL);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  log.info(`Queue database initialized at ${DB_PATH}`);
  return _db;
}

/**
 * Add a new pending change to the queue.
 */
export function addChange(
  change: StagedChange,
  diff: DiffResult,
  agentName = 'openclaw',
  tokenCost = 0
): QueueEntry {
  const db = getDb();

  const entry: QueueEntry = {
    id: change.id,
    file_path: change.filePath,
    diff_text: diff.unified,
    additions: diff.additions,
    deletions: diff.deletions,
    status: 'pending',
    created_at: change.stagedAt.toISOString(),
    resolved_at: null,
    token_cost: tokenCost,
    agent_name: agentName,
  };

  const stmt = db.prepare(`
    INSERT INTO changes (id, file_path, diff_text, additions, deletions, status, created_at, resolved_at, token_cost, agent_name)
    VALUES (@id, @file_path, @diff_text, @additions, @deletions, @status, @created_at, @resolved_at, @token_cost, @agent_name)
  `);

  stmt.run(entry);
  log.info(`Queued change ${entry.id} (${entry.file_path})`);

  return entry;
}

/**
 * Resolve a pending change as approved or rejected.
 */
export function resolveChange(
  id: string,
  status: 'approved' | 'rejected'
): QueueEntry {
  const db = getDb();

  const resolvedAt = new Date().toISOString();

  const stmt = db.prepare(`
    UPDATE changes
    SET status = @status, resolved_at = @resolved_at
    WHERE id = @id AND status = 'pending'
  `);

  const result = stmt.run({ id, status, resolved_at: resolvedAt });

  if (result.changes === 0) {
    const existing = getChange(id);
    if (!existing) throw new Error(`Change ${id} not found`);
    if (existing.status !== 'pending') {
      throw new Error(`Change ${id} is already ${existing.status}`);
    }
    throw new Error(`Failed to resolve change ${id}`);
  }

  log.info(`Change ${id} → ${status}`);

  return getChange(id)!;
}

/**
 * Get a single change by ID.
 */
export function getChange(id: string): QueueEntry | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM changes WHERE id = ?');
  return (stmt.get(id) as QueueEntry | undefined) ?? null;
}

/**
 * Get all pending changes.
 */
export function getPending(): QueueEntry[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM changes WHERE status = 'pending' ORDER BY created_at ASC
  `);
  return stmt.all() as QueueEntry[];
}

/**
 * Get recent change history.
 */
export function getHistory(limit = 20, offset = 0): QueueEntry[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM changes
    WHERE status != 'pending'
    ORDER BY resolved_at DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(limit, offset) as QueueEntry[];
}

/**
 * Count changes by status.
 */
export function countByStatus(): Record<ChangeStatus, number> {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT status, COUNT(*) as count FROM changes GROUP BY status
  `);
  const rows = stmt.all() as Array<{ status: ChangeStatus; count: number }>;

  const result: Record<ChangeStatus, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
  };

  for (const row of rows) {
    result[row.status] = row.count;
  }

  return result;
}

/**
 * Purge old resolved entries beyond a retention count.
 */
export function purgeOldEntries(keepCount = 500): number {
  const db = getDb();
  const stmt = db.prepare(`
    DELETE FROM changes
    WHERE id IN (
      SELECT id FROM changes
      WHERE status != 'pending'
      ORDER BY resolved_at ASC
      LIMIT MAX(0, (SELECT COUNT(*) FROM changes WHERE status != 'pending') - ?)
    )
  `);
  const result = stmt.run(keepCount);
  return result.changes;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info('Queue database closed');
  }
}
