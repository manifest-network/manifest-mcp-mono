/**
 * Leveled logger for MCP server processes.
 *
 * All output goes to stderr because stdout is reserved for MCP protocol messages.
 * The level defaults to `warn`; callers set it explicitly via `logger.setLevel()`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const VALID_LOG_LEVELS = new Set<string>(Object.keys(LOG_LEVEL_ORDER));

/**
 * Parse an untrusted string into a `LogLevel`. Returns `'warn'` for `undefined`,
 * empty, or unrecognized values; emits a stderr warning on the unrecognized case.
 * Node-specific env resolution lives in the node package's bootstrap.
 */
export function parseLogLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'warn';
  if (VALID_LOG_LEVELS.has(raw)) return raw as LogLevel;
  console.error(
    `[WARN] Invalid LOG_LEVEL "${raw}". Valid values: debug, info, warn, error, silent. Defaulting to "warn".`,
  );
  return 'warn';
}

let currentLevel: LogLevel = 'warn';

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
