/**
 * Leveled logger for MCP server processes.
 *
 * All output goes to stderr because stdout is reserved for MCP protocol messages.
 * The level is resolved from `process.env.LOG_LEVEL` at import time and can be
 * overridden at runtime via `logger.setLevel()`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function resolveLevel(): LogLevel {
  const env =
    typeof process !== 'undefined' ? process.env.LOG_LEVEL : undefined;
  if (!env) return 'warn';
  const validLevels = new Set<string>(Object.keys(LOG_LEVEL_ORDER));
  if (validLevels.has(env)) return env as LogLevel;
  console.error(
    `[WARN] Invalid LOG_LEVEL "${env}". Valid values: debug, info, warn, error, silent. Defaulting to "warn".`,
  );
  return 'warn';
}

let currentLevel: LogLevel = resolveLevel();

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLevel];
}

export const logger = {
  debug(...args: unknown[]) {
    if (shouldLog('debug')) console.error('[DEBUG]', ...args);
  },
  info(...args: unknown[]) {
    if (shouldLog('info')) console.error('[INFO]', ...args);
  },
  warn(...args: unknown[]) {
    if (shouldLog('warn')) console.error('[WARN]', ...args);
  },
  error(...args: unknown[]) {
    if (shouldLog('error')) console.error('[ERROR]', ...args);
  },
  setLevel(level: LogLevel) {
    currentLevel = level;
  },
  getLevel(): LogLevel {
    return currentLevel;
  },
};
