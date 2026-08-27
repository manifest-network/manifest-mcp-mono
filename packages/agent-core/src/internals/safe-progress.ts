import {
  logger,
  sanitizeForLogging,
} from '@manifest-network/manifest-mcp-core';

/**
 * Emit best-effort progress without letting a host callback take ownership of
 * orchestration control flow. Progress is observational: a consumer bug must
 * not abort a paid deployment or be misclassified as a chain/provider error.
 */
export function emitProgress<T>(
  callback: ((event: T) => void) | undefined,
  event: T,
): void {
  if (!callback) return;
  try {
    callback(event);
  } catch (error) {
    const detail = sanitizeForLogging(
      error instanceof Error ? error.message : String(error),
    ) as string;
    const kind =
      event !== null &&
      typeof event === 'object' &&
      'kind' in event &&
      typeof event.kind === 'string'
        ? ` for "${event.kind}"`
        : '';
    logger.warn(
      `[agent-core] onProgress callback threw${kind}; continuing orchestration: ${detail}`,
    );
  }
}
