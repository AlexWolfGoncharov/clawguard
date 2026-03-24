import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { getConfig } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

class Logger {
  private logFilePath: string | null = null;
  private logStream: fs.WriteStream | null = null;
  private currentLevel: LogLevel = 'info';

  init(): void {
    const config = getConfig();
    this.currentLevel = config.logging.level;
    this.logFilePath = config.logging.file;

    const dir = path.dirname(this.logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
    } catch (_err) {
      console.warn('[clawguard] Could not open log file:', this.logFilePath);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[this.currentLevel];
  }

  private format(level: LogLevel, namespace: string, message: string): string {
    const ts = new Date().toISOString();
    return `${ts} [${LEVEL_LABELS[level]}] [${namespace}] ${message}`;
  }

  private write(level: LogLevel, namespace: string, message: string, ...args: unknown[]): void {
    if (!this.shouldLog(level)) return;

    const extra = args.length > 0 ? ' ' + args.map((a) => JSON.stringify(a, null, 0)).join(' ') : '';
    const line = this.format(level, namespace, message + extra);

    const colored = LEVEL_COLORS[level](`[${LEVEL_LABELS[level]}]`) +
      chalk.dim(` [${namespace}] `) +
      message +
      (extra ? chalk.dim(extra) : '');

    const prefix = chalk.dim(new Date().toISOString());
    console.log(`${prefix} ${colored}`);

    if (this.logStream) {
      this.logStream.write(line + '\n');
    }
  }

  debug(namespace: string, message: string, ...args: unknown[]): void {
    this.write('debug', namespace, message, ...args);
  }

  info(namespace: string, message: string, ...args: unknown[]): void {
    this.write('info', namespace, message, ...args);
  }

  warn(namespace: string, message: string, ...args: unknown[]): void {
    this.write('warn', namespace, message, ...args);
  }

  error(namespace: string, message: string, ...args: unknown[]): void {
    this.write('error', namespace, message, ...args);
  }

  child(namespace: string): ChildLogger {
    return new ChildLogger(this, namespace);
  }

  close(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
}

export class ChildLogger {
  constructor(
    private parent: Logger,
    private namespace: string
  ) {}

  debug(message: string, ...args: unknown[]): void {
    this.parent.debug(this.namespace, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.parent.info(this.namespace, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.parent.warn(this.namespace, message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.parent.error(this.namespace, message, ...args);
  }

  child(namespace: string): ChildLogger {
    return new ChildLogger(this.parent, `${this.namespace}:${namespace}`);
  }
}

export const logger = new Logger();

export default logger;
