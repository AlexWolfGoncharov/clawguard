/**
 * ClawGuard — OpenClaw plugin entry + standalone server bootstrap.
 *
 * When loaded by OpenClaw as a plugin (dist/index.js via jiti):
 *   The default export { id, configSchema, register(api) } is what OpenClaw calls.
 *   register(api) registers a before_tool_call hook and starts channels as a service.
 *
 * When run directly (npm start / npm run dev):
 *   The isMain block at the bottom bootstraps the HTTP server as a standalone process.
 */

import { loadConfig, getConfig } from './utils/config.js';
import logger from './utils/logger.js';
import { startTelegram, stopTelegram } from './channels/telegram.js';
import { startDiscord, stopDiscord } from './channels/discord.js';
import { startWeb, stopWeb } from './channels/web.js';
import { getBudgetTracker, ensureBudgetReady } from './core/budget.js';
import { getStagingEngine } from './core/staging.js';
import { ensureReady as ensureQueueReady } from './core/queue.js';
import {
  beforeToolCallHandler,
  notifyResolution,
  type BeforeToolCallEvent,
  type BeforeToolCallContext,
} from './openclaw/plugin.js';

export { notifyResolution };
export * from './core/staging.js';
export * from './core/diff.js';
export * from './core/queue.js';
export * from './core/budget.js';

// ── Core initialisation (shared between plugin and standalone modes) ───────────

let _coreReady: Promise<void> | null = null;
let _channelsStarted = false;

/**
 * Idempotent: initialises config, logger, staging dir, and async DBs.
 * Both the hook and the service call this; the promise is shared.
 */
function ensureCoreReady(): Promise<void> {
  if (!_coreReady) {
    _coreReady = (async () => {
      loadConfig();
      logger.init();
      getStagingEngine();
      await ensureQueueReady();
      await ensureBudgetReady();
      getBudgetTracker();
    })();
  }
  return _coreReady;
}

async function startChannels(): Promise<void> {
  if (_channelsStarted) return;
  _channelsStarted = true;

  const config = getConfig();
  const log = logger.child('channels');
  const tasks: Promise<void>[] = [];

  if (config.channels.telegram.enabled) {
    tasks.push(startTelegram().catch((err) => log.error('Telegram failed to start:', err)));
  }
  if (config.channels.discord.enabled) {
    tasks.push(startDiscord().catch((err) => log.error('Discord failed to start:', err)));
  }
  if (config.channels.web.enabled) {
    tasks.push(startWeb().catch((err) => log.error('Web server failed to start:', err)));
  }

  await Promise.allSettled(tasks);
}

async function stopChannels(): Promise<void> {
  _channelsStarted = false;
  await Promise.allSettled([stopTelegram(), stopDiscord(), stopWeb()]);
}

// ── OpenClaw Plugin Definition ────────────────────────────────────────────────

/**
 * Minimal subset of the OpenClaw plugin API used by ClawGuard.
 * Full types: import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core'
 */
interface PluginApi {
  registerHook(
    events: string | string[],
    handler: (event: unknown, ctx: unknown) => unknown,
    opts: { name: string },
  ): void;
  registerService(service: {
    id: string;
    start: (ctx: unknown) => void | Promise<void>;
    stop?: (ctx: unknown) => void | Promise<void>;
  }): void;
  logger: { info(msg: string): void; error(msg: string): void };
}

const configSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    channels: {
      type: 'object',
      additionalProperties: false,
      properties: {
        telegram: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            token: { type: 'string' },
            chatId: { type: 'string' },
          },
        },
        discord: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            token: { type: 'string' },
            channelId: { type: 'string' },
          },
        },
        web: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            host: { type: 'string' },
          },
        },
      },
    },
    budget: {
      type: 'object',
      additionalProperties: false,
      properties: {
        daily_limit_usd: { type: 'number', minimum: 0 },
        alert_threshold_pct: { type: 'integer', minimum: 1, maximum: 100 },
        hard_stop: { type: 'boolean' },
        model_costs: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              input: { type: 'number', minimum: 0 },
              output: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    },
    staging: {
      type: 'object',
      additionalProperties: false,
      properties: {
        directory: { type: 'string' },
        auto_approve_read: { type: 'boolean' },
        require_approval: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'integer', minimum: 0 },
      },
    },
    logging: {
      type: 'object',
      additionalProperties: false,
      properties: {
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
        file: { type: 'string' },
        max_size_mb: { type: 'integer', minimum: 1 },
      },
    },
  },
};

/**
 * Default export — OpenClaw plugin entry point.
 *
 * OpenClaw loads dist/index.js via jiti, reads this object, and calls register(api).
 * resolvePluginModuleExport() in OpenClaw looks for: default.id, default.configSchema,
 * default.register (or default.activate).
 */
const clawguardPlugin = {
  id: 'clawguard',
  name: 'ClawGuard',
  description:
    'Intercepts file write/edit/exec operations and requires human approval before changes are applied.',
  version: '0.1.0',
  configSchema,

  register(api: PluginApi): void {
    api.logger.info('[clawguard] Registering...');

    // Register a managed service that owns the notification channels
    api.registerService({
      id: 'clawguard-core',
      start: async () => {
        await ensureCoreReady();
        await startChannels();
        api.logger.info('[clawguard] Channels started.');
      },
      stop: async () => {
        await stopChannels();
      },
    });

    // Register the tool-call interceptor.
    // ensureCoreReady() inside the hook ensures the DBs are up even if the
    // hook fires before the service's start() has completed.
    api.registerHook(
      'before_tool_call',
      async (event: unknown, ctx: unknown) => {
        await ensureCoreReady();
        return beforeToolCallHandler(
          event as BeforeToolCallEvent,
          ctx as BeforeToolCallContext,
        );
      },
      { name: 'clawguard-before-tool-call' },
    );

    api.logger.info('[clawguard] Plugin registered — intercepting write operations.');
  },
};

export default clawguardPlugin;

// ── Standalone bootstrap (npm start / npm run dev) ────────────────────────────

async function bootstrap(): Promise<void> {
  await ensureCoreReady();

  const log = logger.child('bootstrap');
  log.info('ClawGuard v0.1.0 starting (standalone mode)...');

  await startChannels();

  const config = getConfig();
  const { channels, budget } = config;
  const active: string[] = [];
  if (channels.telegram.enabled) active.push('Telegram');
  if (channels.discord.enabled) active.push('Discord');
  if (channels.web.enabled) active.push(`Web (port ${channels.web.port})`);
  log.info(`Active channels: ${active.join(', ') || 'none'}`);
  log.info(
    `Budget: $${budget.daily_limit_usd}/day | Alert at ${budget.alert_threshold_pct}% | Hard stop: ${budget.hard_stop}`,
  );
  log.info('ClawGuard ready.');
}

async function shutdown(): Promise<void> {
  const log = logger.child('shutdown');
  log.info('Shutting down...');
  await stopChannels();
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

// require.main === module is the correct CJS idiom:
// - true  when run directly:  node dist/index.js  or  tsx src/index.ts
// - false when loaded via require() or jiti (OpenClaw plugin context)
const isMain = typeof require !== 'undefined' && require.main === module;

if (isMain) {
  bootstrap().catch((err) => {
    console.error('[clawguard] Bootstrap failed:', err);
    process.exit(1);
  });
}
