import fs from 'fs';
import path from 'path';
import os from 'os';
import JSON5 from 'json5';

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  chatId: string;
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  channelId: string;
}

export interface WebConfig {
  enabled: boolean;
  port: number;
  host: string;
}

export interface ChannelsConfig {
  telegram: TelegramConfig;
  discord: DiscordConfig;
  web: WebConfig;
}

export interface ModelCost {
  input: number;
  output: number;
}

export interface BudgetConfig {
  daily_limit_usd: number;
  alert_threshold_pct: number;
  hard_stop: boolean;
  model_costs: Record<string, ModelCost>;
}

export interface StagingConfig {
  directory: string;
  auto_approve_read: boolean;
  require_approval: string[];
  timeout_seconds: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file: string;
  max_size_mb: number;
}

export interface ClawGuardConfig {
  channels: ChannelsConfig;
  budget: BudgetConfig;
  staging: StagingConfig;
  logging: LoggingConfig;
}

const DEFAULT_CONFIG: ClawGuardConfig = {
  channels: {
    telegram: {
      enabled: false,
      token: '',
      chatId: '',
    },
    discord: {
      enabled: false,
      token: '',
      channelId: '',
    },
    web: {
      enabled: true,
      port: 3847,
      host: '127.0.0.1',
    },
  },
  budget: {
    daily_limit_usd: 10.0,
    alert_threshold_pct: 80,
    hard_stop: true,
    model_costs: {},
  },
  staging: {
    directory: '/tmp/clawguard/staging',
    auto_approve_read: true,
    require_approval: ['write', 'edit', 'apply_patch', 'exec'],
    timeout_seconds: 300,
  },
  logging: {
    level: 'info',
    file: path.join(os.homedir(), '.clawguard', 'clawguard.log'),
    max_size_mb: 10,
  },
};

function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function mergeDeep<T>(target: T, source: Partial<T>): T {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    (Object.keys(source) as Array<keyof T>).forEach((key) => {
      const sourceVal = source[key];
      if (isObject(sourceVal)) {
        if (!(key in target)) {
          Object.assign(output as object, { [key]: sourceVal });
        } else {
          (output as Record<keyof T, unknown>)[key] = mergeDeep(
            target[key] as object,
            sourceVal as object
          );
        }
      } else if (sourceVal !== undefined) {
        (output as Record<keyof T, unknown>)[key] = sourceVal;
      }
    });
  }
  return output;
}

function isObject(item: unknown): item is Record<string, unknown> {
  return item !== null && typeof item === 'object' && !Array.isArray(item);
}

let _config: ClawGuardConfig | null = null;

export function loadConfig(configPath?: string): ClawGuardConfig {
  if (_config) return _config;

  const searchPaths = [
    configPath,
    process.env['CLAWGUARD_CONFIG'],
    // When loaded as an OpenClaw plugin, cwd is not the project root.
    // __dirname resolves to dist/utils/, so go two levels up to the project root.
    path.join(__dirname, '..', '..', 'config.json5'),
    path.join(process.cwd(), 'config.json5'),
    path.join(os.homedir(), '.clawguard', 'config.json5'),
  ].filter(Boolean) as string[];

  let loaded: Partial<ClawGuardConfig> = {};

  for (const p of searchPaths) {
    const resolved = resolvePath(p);
    if (fs.existsSync(resolved)) {
      try {
        const raw = fs.readFileSync(resolved, 'utf-8');
        loaded = JSON5.parse(raw) as Partial<ClawGuardConfig>;
        break;
      } catch (err) {
        console.warn(`[clawguard] Failed to parse config at ${resolved}:`, err);
      }
    }
  }

  _config = mergeDeep(DEFAULT_CONFIG, loaded);

  // Resolve paths
  _config.staging.directory = resolvePath(_config.staging.directory);
  _config.logging.file = resolvePath(_config.logging.file);

  return _config;
}

export function getConfig(): ClawGuardConfig {
  return _config ?? loadConfig();
}

export function resetConfig(): void {
  _config = null;
}
