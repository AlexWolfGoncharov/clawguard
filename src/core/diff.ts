import * as diffLib from 'diff';
import path from 'path';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffResult {
  filePath: string;
  unified: string;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  isNew: boolean;
  isDeleted: boolean;
}

/**
 * Generate a unified diff between original and modified content.
 */
export function generateDiff(
  original: string,
  modified: string,
  filePath: string
): DiffResult {
  const filename = path.basename(filePath);
  const isNew = original === '';
  const isDeleted = modified === '';

  const unified = diffLib.createPatch(
    filename,
    original,
    modified,
    'original',
    'modified',
    { context: 3 }
  );

  let additions = 0;
  let deletions = 0;
  const hunks: Hunk[] = [];

  // Parse unified diff to extract stats and hunks
  const parsedDiff = diffLib.parsePatch(unified);
  for (const file of parsedDiff) {
    for (const hunk of file.hunks) {
      additions += hunk.lines.filter((l) => l.startsWith('+')).length;
      deletions += hunk.lines.filter((l) => l.startsWith('-')).length;

      hunks.push({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        lines: hunk.lines,
      });
    }
  }

  return {
    filePath,
    unified,
    additions,
    deletions,
    hunks,
    isNew,
    isDeleted,
  };
}

/**
 * Format diff for Telegram (monospace, truncated at 4000 chars).
 */
export function formatForTelegram(diff: DiffResult): string {
  const header = buildHeader(diff);
  const MAX = 4000;

  // Strip the unified diff header lines (--- / +++) for brevity
  const body = diff.unified
    .split('\n')
    .slice(4) // skip "Index:", "===", "---", "+++"
    .join('\n')
    .trim();

  const fullText = `${header}\n\`\`\`diff\n${body}\n\`\`\``;

  if (fullText.length <= MAX) return fullText;

  const truncated = fullText.slice(0, MAX - 100);
  const lastNewline = truncated.lastIndexOf('\n');
  return truncated.slice(0, lastNewline) + '\n...(truncated)\n```';
}

/**
 * Format diff for Discord (code block, truncated at 2000 chars).
 */
export function formatForDiscord(diff: DiffResult): string {
  const header = buildHeader(diff);
  const MAX = 2000;

  const body = diff.unified
    .split('\n')
    .slice(4)
    .join('\n')
    .trim();

  const fullText = `${header}\n\`\`\`diff\n${body}\n\`\`\``;

  if (fullText.length <= MAX) return fullText;

  const truncated = fullText.slice(0, MAX - 80);
  const lastNewline = truncated.lastIndexOf('\n');
  return truncated.slice(0, lastNewline) + '\n...(truncated)\n```';
}

/**
 * Format diff as HTML for the web UI (syntax-highlighted).
 */
export function formatForWeb(diff: DiffResult): string {
  const lines = diff.unified.split('\n');
  const htmlLines: string[] = [];

  for (const line of lines) {
    let cls = 'ctx';
    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk';
    else if (line.startsWith('---') || line.startsWith('+++')) cls = 'header';

    const escaped = escapeHtml(line);
    htmlLines.push(`<div class="diff-line diff-${cls}"><span class="diff-gutter">${getGutterSymbol(line)}</span><span class="diff-text">${escaped}</span></div>`);
  }

  return `<div class="diff-block">${htmlLines.join('')}</div>`;
}

function getGutterSymbol(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return '+';
  if (line.startsWith('-') && !line.startsWith('---')) return '-';
  if (line.startsWith('@@')) return '↕';
  return ' ';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHeader(diff: DiffResult): string {
  const tag = diff.isNew ? '🆕 NEW FILE' : diff.isDeleted ? '🗑 DELETED' : '✏️ MODIFIED';
  return `${tag} \`${diff.filePath}\`\n+${diff.additions} / -${diff.deletions}`;
}

/**
 * Quick human-readable summary of a diff.
 */
export function summarizeDiff(diff: DiffResult): string {
  const parts: string[] = [];
  if (diff.isNew) parts.push('new file');
  if (diff.isDeleted) parts.push('deleted');
  if (!diff.isNew && !diff.isDeleted) {
    parts.push(`+${diff.additions} -${diff.deletions}`);
  }
  parts.push(`in ${path.basename(diff.filePath)}`);
  return parts.join(' ');
}
