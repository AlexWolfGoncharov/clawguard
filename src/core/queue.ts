import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
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

let _db: SqlJsDatabase | null = null;
let _dbReady: Promise<void> | null = null;

function save(): void {
  if (!_db) return;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function initDb(): Promise<SqlJsDatabase> {
  if (_db) return _db;

  const SQL = await initSqlJs();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(buf);
  } else {
    _db = new SQL.Database();
  }

  _db.run(CREATE_TABLE_SQL);
  save();
  log.info(`Queue database initialized at ${DB_PATH}`);
  return _db;
}

function getDb(): SqlJsDatabase {
  if (!_db) throw new Error('Database not initialized. Call ensureReady() first.');
  return _db;
}

export async function ensureReady(): Promise<void> {
  if (_db) return;
  if (!_dbReady) {
    _dbReady = initDb().then(() => {});
  }
  await _dbReady;
}

// Auto-init for sync callers (call ensureReady() at startup for safety)
function autoInit(): SqlJsDatabase {
  if (!_db) {
    // Synchronous fallback — only works if ensureReady() was called at startup
    throw new Error('Queue DB not ready. Call await ensureReady() during bootstrap.');
  }
  return _db;
}

function rowToEntry(row: Record<string, unknown>): QueueEntry {
  return {
    id: row['id'] as string,
    file_path: row['file_path'] as string,
    diff_text: row['diff_text'] as string,
    additions: row['additions'] as number,
    deletions: row['deletions'] as number,
    status: row['status'] as ChangeStatus,
    created_at: row['created_at'] as string,
    resolved_at: (row['resolved_at'] as string) ?? null,
    token_cost: row['token_cost'] as number,
    agent_name: row['agent_name'] as string,
  };
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
  const db = autoInit();

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

  db.run(
    `INSERT INTO changes (id, file_path, diff_text, additions, deletions, status, created_at, resolved_at, token_cost, agent_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.file_path, entry.diff_text, entry.additions, entry.deletions,
     entry.status, entry.created_at, entry.resolved_at, entry.token_cost, entry.agent_name]
  );
  save();

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
  const db = autoInit();
  const resolvedAt = new Date().toISOString();

  db.run(
    `UPDATE changes SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
    [status, resolvedAt, id]
  );

  const changes = db.getRowsModified();
  if (changes === 0) {
    const existing = getChange(id);
    if (!existing) throw new Error(`Change ${id} not found`);
    if (existing.status !== 'pending') {
      throw new Error(`Change ${id} is already ${existing.status}`);
    }
    throw new Error(`Failed to resolve change ${id}`);
  }

  save();
  log.info(`Change ${id} → ${status}`);
  return getChange(id)!;
}

/**
 * Get a single change by ID.
 */
export function getChange(id: string): QueueEntry | null {
  const db = autoInit();
  const stmt = db.prepare('SELECT * FROM changes WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return rowToEntry(row);
  }
  stmt.free();
  return null;
}

/**
 * Get all pending changes.
 */
export function getPending(): QueueEntry[] {
  const db = autoInit();
  const results: QueueEntry[] = [];
  const stmt = db.prepare(`SELECT * FROM changes WHERE status = 'pending' ORDER BY created_at ASC`);
  while (stmt.step()) {
    results.push(rowToEntry(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

/**
 * Get recent change history.
 */
export function getHistory(limit = 20, offset = 0): QueueEntry[] {
  const db = autoInit();
  const results: QueueEntry[] = [];
  const stmt = db.prepare(
    `SELECT * FROM changes WHERE status != 'pending' ORDER BY resolved_at DESC LIMIT ? OFFSET ?`
  );
  stmt.bind([limit, offset]);
  while (stmt.step()) {
    results.push(rowToEntry(stmt.getAsObject()));
  }
  stmt.free();
  return results;
}

/**
 * Count changes by status.
 */
export function countByStatus(): Record<ChangeStatus, number> {
  const db = autoInit();
  const result: Record<ChangeStatus, number> = { pending: 0, approved: 0, rejected: 0 };
  const stmt = db.prepare('SELECT status, COUNT(*) as count FROM changes GROUP BY status');
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const s = row['status'] as ChangeStatus;
    result[s] = row['count'] as number;
  }
  stmt.free();
  return result;
}

/**
 * Purge old resolved entries beyond a retention count.
 */
export function purgeOldEntries(keepCount = 500): number {
  const db = autoInit();
  db.run(
    `DELETE FROM changes WHERE id IN (
      SELECT id FROM changes WHERE status != 'pending'
      ORDER BY resolved_at ASC
      LIMIT MAX(0, (SELECT COUNT(*) FROM changes WHERE status != 'pending') - ?)
    )`,
    [keepCount]
  );
  const deleted = db.getRowsModified();
  save();
  return deleted;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (_db) {
    save();
    _db.close();
    _db = null;
    log.info('Queue database closed');
  }
}
