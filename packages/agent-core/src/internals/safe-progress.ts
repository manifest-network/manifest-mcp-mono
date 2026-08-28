import {
  logger,
  sanitizeForLogging,
} from '@manifest-network/manifest-mcp-core';
import type { ProgressEvent } from '../types.js';

type SimpleFailure = { reason: string };

/** Log a host callback failure without allowing callback-owned data to leak. */
export function logCallbackFailure(
  callbackName: 'onProgress' | 'onComplete' | 'onFailure',
  error: unknown,
  context = '',
): void {
  const detail = sanitizeForLogging(
    error instanceof Error ? error.message : String(error),
  ) as string;
  logger.warn(
    `[agent-core] ${callbackName} callback failed${context}; continuing orchestration: ${detail}`,
  );
}

function observeCallbackResult(
  callbackName: 'onProgress' | 'onComplete',
  result: unknown,
  context: string,
): void {
  // Callback contracts are intentionally observational and typed as `void`,
  // but JavaScript hosts can still supply an async function. Observe that
  // returned thenable so a rejection cannot become an unhandled rejection.
  if (
    (typeof result === 'object' && result !== null) ||
    typeof result === 'function'
  ) {
    void Promise.resolve(result).catch((error: unknown) => {
      logCallbackFailure(callbackName, error, context);
    });
  }
}

/**
 * Emit best-effort progress without letting a host callback take ownership of
 * orchestration control flow. Progress is observational: a consumer bug must
 * not abort a paid deployment or be misclassified as a chain/provider error.
 */
export function emitProgress(
  callback: ((event: ProgressEvent) => void) | undefined,
  event: ProgressEvent,
): void {
  if (!callback) return;
  const context = ` for "${event.kind}"`;
  try {
    const result = (callback as (event: ProgressEvent) => unknown)(event);
    observeCallbackResult('onProgress', result, context);
  } catch (error) {
    logCallbackFailure('onProgress', error, context);
  }
}

/** Run an observational completion hook without changing the operation result. */
export function emitCompletion(invoke: () => unknown): void {
  try {
    observeCallbackResult('onComplete', invoke(), '');
  } catch (error) {
    logCallbackFailure('onComplete', error);
  }
}

/** Notify a simple failure observer while preserving the operation's error. */
export async function notifyFailure(
  callback: ((failure: SimpleFailure) => Promise<void>) | undefined,
  failure: SimpleFailure,
): Promise<void> {
  if (!callback) return;
  try {
    await callback(failure);
  } catch (error) {
    logCallbackFailure('onFailure', error);
  }
}
