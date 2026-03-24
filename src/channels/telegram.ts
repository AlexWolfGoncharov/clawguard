import { Telegraf, Markup, Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { getConfig } from '../utils/config.js';
import logger from '../utils/logger.js';
import { formatForTelegram } from '../core/diff.js';
import * as queue from '../core/queue.js';
import { getStagingEngine } from '../core/staging.js';
import { getBudgetTracker } from '../core/budget.js';
import type { QueueEntry } from '../core/queue.js';
import type { DiffResult } from '../core/diff.js';

const log = logger.child('telegram');

let bot: Telegraf | null = null;
let chatId: string = '';

function _getBot(): Telegraf {
  if (!bot) throw new Error('Telegram bot not initialized. Call startTelegram() first.');
  return bot;
}

/**
 * Initialize and start the Telegram bot.
 */
export async function startTelegram(): Promise<void> {
  const config = getConfig();
  if (!config.channels.telegram.enabled) {
    log.info('Telegram channel disabled in config');
    return;
  }

  const { token, chatId: configuredChatId } = config.channels.telegram;

  if (!token || token === 'YOUR_BOT_TOKEN') {
    log.warn('Telegram token not configured — skipping');
    return;
  }

  chatId = configuredChatId;
  bot = new Telegraf(token);

  // Register commands
  bot.command('start', handleStart);
  bot.command('help', handleHelp);
  bot.command('budget', handleBudget);
  bot.command('pending', handlePending);
  bot.command('history', handleHistory);

  // Handle inline button callbacks
  bot.action(/^approve:(.+)$/, handleApprove);
  bot.action(/^reject:(.+)$/, handleReject);

  // Error handling
  bot.catch((err, ctx) => {
    log.error(`Bot error for ${ctx.updateType}:`, err);
  });

  try {
    await bot.launch();
    log.info('Telegram bot started');
  } catch (err) {
    log.error('Failed to start Telegram bot:', err);
    throw err;
  }

  // Graceful shutdown
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
}

/**
 * Send a diff notification with approve/reject buttons.
 */
export async function sendDiffNotification(
  entry: QueueEntry,
  diff: DiffResult
): Promise<void> {
  if (!bot || !chatId) return;

  const text = formatForTelegram(diff);
  const keyboard = buildApprovalKeyboard(entry.id);

  try {
    await bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    log.info(`Sent diff notification for change ${entry.id}`);
  } catch (err) {
    log.error(`Failed to send Telegram notification for ${entry.id}:`, err);
  }
}

function buildApprovalKeyboard(changeId: string): InlineKeyboardMarkup {
  return Markup.inlineKeyboard([
    Markup.button.callback('✅ Apply', `approve:${changeId}`),
    Markup.button.callback('❌ Reject', `reject:${changeId}`),
  ]).reply_markup;
}

// ── Command handlers ─────────────────────────────────────────────────────────

async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(
    '🛡 *ClawGuard* is active.\n\nYou will receive file change diffs here for approval. Use /help for available commands.',
    { parse_mode: 'Markdown' }
  );
}

async function handleHelp(ctx: Context): Promise<void> {
  const help = `*ClawGuard Commands*

/budget — Show today's spending
/pending — List pending changes
/history — Show recent decisions
/help — Show this message

*Approving Changes*
When a change arrives, tap ✅ Apply or ❌ Reject on the inline buttons.`;

  await ctx.reply(help, { parse_mode: 'Markdown' });
}

async function handleBudget(ctx: Context): Promise<void> {
  const tracker = getBudgetTracker();
  const status = tracker.checkBudget();

  const bar = buildProgressBar(status.percentage);
  const emoji = status.blocked ? '🔴' : status.alert ? '🟡' : '🟢';

  const text =
    `${emoji} *Budget Status*\n\n` +
    `Today: \`$${status.used_today_usd.toFixed(4)}\` / \`$${status.limit_usd.toFixed(2)}\`\n` +
    `${bar} ${status.percentage.toFixed(1)}%\n\n` +
    `Session: \`$${status.session_usd.toFixed(4)}\`\n` +
    `Tokens today: \`${status.total_tokens_today.toLocaleString()}\`\n` +
    (status.blocked ? '\n⛔ *Agent is currently blocked (limit reached)*' : '') +
    (status.alert && !status.blocked ? '\n⚠️ *Alert threshold reached*' : '');

  await ctx.reply(text, { parse_mode: 'Markdown' });
}

async function handlePending(ctx: Context): Promise<void> {
  const pending = queue.getPending();

  if (pending.length === 0) {
    await ctx.reply('✅ No pending changes.');
    return;
  }

  const lines = pending.map((e, i) => {
    const ago = timeAgo(new Date(e.created_at));
    return `${i + 1}. \`${e.file_path}\` (+${e.additions}/-${e.deletions}) — ${ago}`;
  });

  const text = `*Pending Changes (${pending.length})*\n\n${lines.join('\n')}`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
}

async function handleHistory(ctx: Context): Promise<void> {
  const history = queue.getHistory(10);

  if (history.length === 0) {
    await ctx.reply('No history yet.');
    return;
  }

  const lines = history.map((e) => {
    const icon = e.status === 'approved' ? '✅' : '❌';
    const ago = timeAgo(new Date(e.resolved_at ?? e.created_at));
    return `${icon} \`${e.file_path}\` — ${ago}`;
  });

  await ctx.reply(`*Recent Decisions*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
}

async function handleApprove(ctx: Context): Promise<void> {
  const match = (ctx as Context & { match: RegExpExecArray }).match;
  const changeId = match[1];

  try {
    const staging = getStagingEngine();
    queue.resolveChange(changeId, 'approved');
    staging.apply(changeId);

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.answerCbQuery('✅ Change applied to filesystem');
    await ctx.reply(`✅ Applied change \`${changeId.slice(0, 8)}...\``, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    log.error(`Approve failed for ${changeId}:`, err);
    await ctx.answerCbQuery('❌ Error applying change');
    await ctx.reply(
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function handleReject(ctx: Context): Promise<void> {
  const match = (ctx as Context & { match: RegExpExecArray }).match;
  const changeId = match[1];

  try {
    const staging = getStagingEngine();
    queue.resolveChange(changeId, 'rejected');
    staging.reject(changeId);

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.answerCbQuery('❌ Change rejected');
    await ctx.reply(`❌ Rejected change \`${changeId.slice(0, 8)}...\``, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    log.error(`Reject failed for ${changeId}:`, err);
    await ctx.answerCbQuery('Error rejecting change');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildProgressBar(percentage: number, width = 12): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function stopTelegram(): void {
  bot?.stop();
  bot = null;
}
