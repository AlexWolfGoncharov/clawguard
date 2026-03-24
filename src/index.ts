/**
 * ClawGuard — Staging layer & budget control for OpenClaw agents
 *
 * Entry point: initializes all channels and exports the plugin.
 */

import { loadConfig } from './utils/config.js';
import logger from './utils/logger.js';
import { startTelegram, stopTelegram } from './channels/telegram.js';
import { startDiscord, stopDiscord } from './channels/discord.js';
import { startWeb, stopWeb } from './channels/web.js';
import { getBudgetTracker } from './core/budget.js';
import { getStagingEngine } from './core/staging.js';
import ClawGuardPlugin, { notifyResolution } from './openclaw/plugin.js';

export { ClawGuardPlugin, notifyResolution };
export * from './core/staging.js';
export * from './core/diff.js';
export * from './core/queue.js';
export * from './core/budget.js';
export * from './openclaw/plugin.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  logger.init();

  const log = logger.child('bootstrap');
  log.info('ClawGuard v0.1.0 starting...');

  // Ensure staging directory exists
  getStagingEngine();

  // Ensure budget tracker is ready
  getBudgetTracker();

  // Start configured channels
  const startTasks: Array<Promise<void>> = [];

  if (config.channels.telegram.enabled) {
    startTasks.push(
      startTelegram().catch((err) => {
        log.error('Telegram failed to start:', err);
      })
    );
  }

  if (config.channels.discord.enabled) {
    startTasks.push(
      startDiscord().catch((err) => {
        log.error('Discord failed to start:', err);
      })
    );
  }

  if (config.channels.web.enabled) {
    startTasks.push(
      startWeb().catch((err) => {
        log.error('Web server failed to start:', err);
      })
    );
  }

  await Promise.allSettled(startTasks);

  log.info('ClawGuard ready.');
  logStatus(log);
}

function logStatus(log: ReturnType<typeof logger.child>): void {
  const config = loadConfig();
  const { channels, budget } = config;

  const activeChannels: string[] = [];
  if (channels.telegram.enabled) activeChannels.push('Telegram');
  if (channels.discord.enabled) activeChannels.push('Discord');
  if (channels.web.enabled) activeChannels.push(`Web (port ${channels.web.port})`);

  log.info(`Active channels: ${activeChannels.join(', ') || 'none'}`);
  log.info(
    `Budget: $${budget.daily_limit_usd}/day | Alert at ${budget.alert_threshold_pct}% | Hard stop: ${budget.hard_stop}`
  );
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  const log = logger.child('shutdown');
  log.info('Shutting down...');

  await Promise.allSettled([stopTelegram(), stopDiscord(), stopWeb()]);

  logger.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('[clawguard] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[clawguard] Unhandled rejection:', reason);
});

// Run if called directly
const isMain =
  process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.endsWith('index.js');

if (isMain) {
  bootstrap().catch((err) => {
    console.error('[clawguard] Bootstrap failed:', err);
    process.exit(1);
  });
}

export default ClawGuardPlugin;
