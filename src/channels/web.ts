import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import fs from 'fs';

import { getConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { generateDiff, formatForWeb } from '../core/diff.js';
import * as queue from '../core/queue.js';
import { getStagingEngine } from '../core/staging.js';
import { getBudgetTracker } from '../core/budget.js';
import { notifyResolution } from '../openclaw/plugin.js';

const log = logger.child('web');

const WEB_DIR = path.resolve(__dirname, '..', '..', 'web');

const app = express();
let server: ReturnType<typeof app.listen> | null = null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (fs.existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR));
}

// ── API Routes ────────────────────────────────────────────────────────────────

/**
 * POST /api/stage — Agent submits a file change for review (standalone / skill mode).
 * In plugin mode changes are intercepted automatically; this endpoint still works
 * for skill-based or manual submissions.
 */
app.post('/api/stage', (req: Request, res: Response) => {
  try {
    const { file_path: filePath, new_content: newContent, agent_name: agentName } = req.body as {
      file_path?: string;
      new_content?: string;
      agent_name?: string;
    };

    if (!filePath || newContent === undefined) {
      return res.status(400).json({ error: 'file_path and new_content are required' });
    }

    const staging = getStagingEngine();
    const staged = staging.stage(filePath, newContent);
    const diff = generateDiff(staged.originalContent, staged.newContent, filePath);
    const entry = queue.addChange(staged, diff, agentName ?? 'openclaw');

    log.info(`Agent staged change ${entry.id} for ${filePath}`);

    return res.json({
      id: entry.id,
      file_path: entry.file_path,
      status: entry.status,
      additions: entry.additions,
      deletions: entry.deletions,
      diff_preview: diff.unified.substring(0, 500),
      review_url: `http://localhost:${getConfig().channels.web.port}/diff.html?id=${entry.id}`,
    });
  } catch (err) {
    log.error('Stage failed:', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * GET /api/status — Overall system status.
 */
app.get('/api/status', (_req: Request, res: Response) => {
  const tracker = getBudgetTracker();
  const budgetStatus = tracker.checkBudget();
  const counts = queue.countByStatus();

  res.json({
    pending: counts.pending,
    approved: counts.approved,
    rejected: counts.rejected,
    budget: budgetStatus,
    uptime: process.uptime(),
  });
});

/**
 * GET /api/changes — List changes with optional ?status=pending filter.
 */
app.get('/api/changes', (req: Request, res: Response) => {
  const status = req.query['status'] as string | undefined;

  if (status === 'pending') {
    return res.json(queue.getPending());
  }

  const limit = parseInt(String(req.query['limit'] ?? '50'), 10);
  const offset = parseInt(String(req.query['offset'] ?? '0'), 10);
  return res.json(queue.getHistory(limit, offset));
});

/**
 * GET /api/changes/:id — Single change with rendered diff HTML.
 */
app.get('/api/changes/:id', (req: Request, res: Response) => {
  const entry = queue.getChange(req.params['id']!);
  if (!entry) return res.status(404).json({ error: 'Change not found' });

  const staging = getStagingEngine();
  let diffHtml = '';

  try {
    const original = staging.getOriginal(entry.id);
    const staged = staging.getStaged(entry.id);
    const diff = generateDiff(original, staged, entry.file_path);
    diffHtml = formatForWeb(diff);
  } catch {
    diffHtml = renderStoredDiff(entry.diff_text);
  }

  return res.json({ ...entry, diff_html: diffHtml });
});

/**
 * POST /api/changes/:id/approve
 *
 * Plugin mode  → calls notifyResolution() which unblocks the waiting hook.
 *                The hook handles resolveChange + staging cleanup.
 * Standalone   → notifyResolution returns false; we apply the change directly.
 */
app.post('/api/changes/:id/approve', (req: Request, res: Response) => {
  const id = req.params['id']!;

  try {
    const handledByHook = notifyResolution(id, true);

    if (!handledByHook) {
      // Standalone mode: no hook is waiting, apply to filesystem now
      const staging = getStagingEngine();
      queue.resolveChange(id, 'approved');
      staging.apply(id);
    }

    log.info(`Web UI approved change ${id}${handledByHook ? ' (plugin mode)' : ' (standalone)'}`);
    return res.json({ success: true });
  } catch (err) {
    log.error(`Approve failed for ${id}:`, err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * POST /api/changes/:id/reject
 *
 * Same dual-mode logic as approve.
 */
app.post('/api/changes/:id/reject', (req: Request, res: Response) => {
  const id = req.params['id']!;

  try {
    const handledByHook = notifyResolution(id, false);

    if (!handledByHook) {
      const staging = getStagingEngine();
      queue.resolveChange(id, 'rejected');
      staging.reject(id);
    }

    log.info(`Web UI rejected change ${id}${handledByHook ? ' (plugin mode)' : ' (standalone)'}`);
    return res.json({ success: true });
  } catch (err) {
    log.error(`Reject failed for ${id}:`, err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * GET /api/budget — Budget details and 7-day breakdown.
 */
app.get('/api/budget', (_req: Request, res: Response) => {
  const tracker = getBudgetTracker();
  const status = tracker.checkBudget();
  const breakdown = tracker.getDailyBreakdown(7);
  res.json({ status, breakdown });
});

/**
 * GET /api/budget/history — Raw usage records.
 */
app.get('/api/budget/history', (req: Request, res: Response) => {
  const tracker = getBudgetTracker();
  const days = parseInt(String(req.query['days'] ?? '7'), 10);
  res.json(tracker.getHistory(days));
});

/**
 * GET /api/events — SSE stream for real-time dashboard updates.
 */
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const interval = setInterval(() => {
    const counts = queue.countByStatus();
    const tracker = getBudgetTracker();
    const budget = tracker.checkBudget();
    res.write(`data: ${JSON.stringify({ counts, budget, ts: Date.now() })}\n\n`);
  }, 5000);

  req.on('close', () => clearInterval(interval));
});

// Catch-all: serve index.html for SPA routing
app.get('*', (_req: Request, res: Response) => {
  const indexPath = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Web UI not found. Run from the project root.');
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error('Express error:', err);
  res.status(500).json({ error: err.message });
});

// ── Server lifecycle ──────────────────────────────────────────────────────────

export function startWeb(): Promise<void> {
  const config = getConfig();
  if (!config.channels.web.enabled) {
    log.info('Web channel disabled in config');
    return Promise.resolve();
  }

  const { port, host } = config.channels.web;

  return new Promise((resolve, reject) => {
    server = app.listen(port, host, () => {
      log.info(`Web dashboard running at http://${host}:${port}`);
      resolve();
    });

    server.on('error', (err) => {
      log.error('Web server error:', err);
      reject(err);
    });
  });
}

export function stopWeb(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      log.info('Web server stopped');
      resolve();
    });
  });
}

export { app };

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderStoredDiff(diffText: string): string {
  const lines = diffText.split('\n');
  const htmlLines = lines.map((line) => {
    let cls = 'ctx';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('---') || line.startsWith('+++')) cls = 'header';

    const gutter = cls === 'add' ? '+' : cls === 'del' ? '-' : cls === 'hunk' ? '↕' : ' ';
    const escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return `<div class="diff-line diff-${cls}"><span class="diff-gutter">${gutter}</span><span class="diff-text">${escaped}</span></div>`;
  });

  return `<div class="diff-block">${htmlLines.join('')}</div>`;
}
