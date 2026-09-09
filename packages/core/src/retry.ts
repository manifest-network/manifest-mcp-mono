import type { QueryErrorDetails } from './internals/classify-query-error.js';
import { errorChain } from './internals/error-chain.js';
import { abortableSleep, abortReason } from './options.js';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type RetryConfig,
} from './types.js';

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/**
 * Error codes that should NOT be retried (permanent failures)
 */
const NON_RETRYABLE_ERROR_CODES: ManifestMCPErrorCode[] = [
  // Configuration errors - won't change on retry
  ManifestMCPErrorCode.INVALID_CONFIG,

  // Wallet errors - require user action
  ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
  ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
  ManifestMCPErrorCode.INVALID_MNEMONIC,

  // Validation errors - input is invalid
  ManifestMCPErrorCode.INVALID_ADDRESS,
  ManifestMCPErrorCode.INVALID_ARGUMENT,

  // The chain answered "no such entity" — an expected, permanent answer.
  // Retrying cannot change it (ENG-536).
  ManifestMCPErrorCode.NOT_FOUND,

  ManifestMCPErrorCode.UNSUPPORTED_TX,
  ManifestMCPErrorCode.UNSUPPORTED_QUERY,
  ManifestMCPErrorCode.UNKNOWN_MODULE,

  // Transaction failures - on-chain rejection. Retrying could cause
  // double-spend for non-idempotent operations.
  ManifestMCPErrorCode.TX_FAILED,

  // Gas-ceiling breach - a deterministic pre-broadcast safety abort (ENG-556).
  // Retrying cannot lower the simulated gas; keep it envelope-free so it
  // short-circuits here and never reaches the grpcCode/httpStatus branches.
  ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,

  // User-action errors - a deliberate decline / cancel / elicitation-timeout.
  // Retrying a user's cancel is nonsensical (ENG-272).
  ManifestMCPErrorCode.OPERATION_CANCELLED,

  // SKU resolution - ambiguous name needs caller disambiguation, not retry
  ManifestMCPErrorCode.SKU_AMBIGUOUS,

  // Restore outcomes (ENG-599). ALL are non-auto-retryable: restore_app is
  // non-idempotent (each call creates a fresh lease), so withRetry must never
  // re-broadcast it. RESTORE_RETRYABLE remains exported for compatibility but
  // restoreApp no longer emits it: a POST status cannot establish safe replay.
  // Messages may contain HTTP statuses that otherwise match retryable errors.
  ManifestMCPErrorCode.RESTORE_NOT_RETAINED,
  ManifestMCPErrorCode.RESTORE_REJECTED,
  ManifestMCPErrorCode.RESTORE_RETRYABLE,
  ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
  ManifestMCPErrorCode.RESTORE_COMMITTED_FAILURE,

  // Readiness never confirmed (ENG-661). The lease EXISTS and is paid for, so a
  // blind retry of the deploy that produced this would create a second one. The
  // remedy is to look (app_status / wait_for_app_ready), not to re-broadcast.
  ManifestMCPErrorCode.DEPLOY_READINESS_UNCONFIRMED,

  // Update outcome unknown (ENG-619). update_app is non-idempotent and the 5xx
  // that produced this may mean the manifest is ALREADY applied on the backend,
  // so an auto-retry re-applies a change the caller has not confirmed. The
  // remedy is to look (app_status / app_releases). Enrolling it here also stops
  // the 5xx message-sniff below from reading the embedded "HTTP 500" as
  // retryable — the same trap the RESTORE_* codes above are enrolled against.
  ManifestMCPErrorCode.UPDATE_INDETERMINATE,
];

/**
 * The transient gRPC status codes: 4 DEADLINE_EXCEEDED, 8 RESOURCE_EXHAUSTED
 * (the 429 analogue), 14 UNAVAILABLE. Every other enveloped status is a fixed
 * answer. Per the gRPC retry design (grpc/proposal A6), retryability is the
 * service owner's call and hinges on IDEMPOTENCE — DEADLINE_EXCEEDED in
 * particular is retry-safe only for idempotent operations.
 *
 * That precondition holds by construction: `details.grpcCode` is set ONLY by
 * `classifyLcdError` (the LCD *query* adapter), so this branch is reachable only
 * from idempotent reads. A tx broadcast never populates grpcCode — its failures
 * wrap to `TX_FAILED`, which is in NON_RETRYABLE_ERROR_CODES and short-circuits
 * above. DO NOT set `details.grpcCode` on a tx/broadcast path without revisiting
 * this: it would make DEADLINE_EXCEEDED retry a double-broadcast hazard.
 */
const RETRYABLE_GRPC_CODES = [4, 8, 14];

/**
 * Check if an error message indicates a transient failure that should be retried.
 *
 * Uses specific patterns to avoid false positives (e.g. "proposal 500" matching
 * bare "500", or "connection to validator not authorized" matching "connection").
 */
function isTransientErrorMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // Node.js / system error codes (specific, no false positives)
  if (
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('etimedout') ||
    lowerMessage.includes('eai_again') ||
    lowerMessage.includes('epipe') ||
    lowerMessage.includes('socket hang up') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('network request failed') ||
    lowerMessage.includes('fetch failed')
  ) {
    return true;
  }

  // HTTP 5xx errors — match "HTTP 5xx" or "status 5xx" patterns, not bare numbers
  if (/\b(?:http|status)\s*5\d{2}\b/.test(lowerMessage)) {
    return true;
  }

  // HTTP 5xx descriptive strings
  if (
    lowerMessage.includes('internal server error') ||
    lowerMessage.includes('bad gateway') ||
    lowerMessage.includes('service unavailable') ||
    lowerMessage.includes('gateway timeout')
  ) {
    return true;
  }

  // Rate limiting
  if (
    /\b429\b/.test(lowerMessage) ||
    lowerMessage.includes('too many requests')
  ) {
    return true;
  }

  return false;
}

function errorCode(error: Error): string {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/** A gRPC envelope is authoritative over HTTP status and message text (ENG-536). */
function queryStatusRetryability(error: Error): boolean | undefined {
  if (!(error instanceof ManifestMCPError)) return undefined;
  const { httpStatus, grpcCode } = (error.details ?? {}) as QueryErrorDetails;
  // Keepers can return HTTP 500 with a deterministic code:2 answer. Only
  // explicitly transient gRPC codes authorize another idempotent query.
  if (typeof grpcCode === 'number')
    return RETRYABLE_GRPC_CODES.includes(grpcCode);
  if (typeof httpStatus === 'number')
    return httpStatus >= 500 || httpStatus === 429;
  return undefined;
}

function isPermanentError(error: Error): boolean {
  // A generic "fetch failed" wrapper must not conceal NXDOMAIN on its cause.
  if (
    errorCode(error).toLowerCase() === 'enotfound' ||
    error.message.toLowerCase().includes('enotfound')
  )
    return true;
  if (queryStatusRetryability(error) === false) return true;
  return (
    error instanceof ManifestMCPError &&
    (NON_RETRYABLE_ERROR_CODES.includes(error.code) ||
      // An existing lease or submitted operation must be reconciled, never replayed.
      error.details?.partial === true ||
      error.details?.sent === true)
  );
}

/**
 * Classify an error and its causes. A native abort/deadline has no ownership
 * information by itself. Only a query/connection boundary that owns the failed
 * transport attempt may annotate it with `transportCode: 'ETIMEDOUT'`.
 * Pass the whole-operation signal to suppress retry after caller cancellation.
 */
export function isRetryableError(
  error: unknown,
  options: { signal?: AbortSignal } = {},
): boolean {
  if (!(error instanceof Error)) return false;
  const chain = errorChain(error);
  // Permanent verdicts in any cause dominate transient wrappers and markers.
  if (chain.some(isPermanentError) || options.signal?.aborted) return false;

  let transportTimeout = false;
  for (const entry of chain) {
    // A marker may own a nested native timeout/stream abort, but cannot authorize
    // retry of an outer cancellation that wraps a previous transport failure.
    if (entry.name === 'AbortError' || entry.name === 'TimeoutError') {
      return transportTimeout;
    }
    if (
      entry instanceof ManifestMCPError &&
      (entry.code === ManifestMCPErrorCode.QUERY_FAILED ||
        entry.code === ManifestMCPErrorCode.RPC_CONNECTION_FAILED) &&
      entry.details?.transportCode === 'ETIMEDOUT'
    )
      transportTimeout = true;
  }
  return (
    transportTimeout ||
    chain.some(
      (entry) =>
        queryStatusRetryability(entry) === true ||
        isTransientErrorMessage(entry.message) ||
        isTransientErrorMessage(errorCode(entry)),
    )
  );
}

/**
 * Calculate delay with exponential backoff and jitter
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap
 * @returns Delay in milliseconds
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelayMs * 2 ** attempt;

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter (±25% randomization to prevent thundering herd)
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);

  return Math.floor(cappedDelay + jitter);
}

/**
 * Options for the retry wrapper
 */
export interface RetryOptions {
  /**
   * Whole-operation cancellation: prevents attempts and interrupts backoff.
   * The operation must observe this signal to cancel its own in-flight work;
   * withRetry does not race that work or discard a successful result.
   */
  signal?: AbortSignal;
  /** Retry configuration */
  config?: RetryConfig;
  /** Operation name for error messages */
  operationName?: string;
  /** Callback invoked before each retry attempt */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Execute an async operation with retry logic for transient failures
 *
 * DO NOT NEST. Ladders multiply (attempts^depth): an operation that already
 * retries internally — notably `CosmosClientManager.getQueryClient` /
 * `getSigningClient`, whose RPC branch also builds five namespace clients per
 * attempt — must be invoked OUTSIDE any enclosing `withRetry`, not from inside
 * the operation body. Nesting the two turned a dead-RPC query into 4 x 4 x 5 =
 * 77 connects / ~35s (ENG-679). Retry policy belongs to exactly one layer.
 *
 * @param operation - Async function to execute
 * @param options - Retry options
 * @returns Result of the operation
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetchData(),
 *   { config: { maxRetries: 3 }, operationName: 'fetchData' }
 * );
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const signal = options.signal;
  const config = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.config,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Preserve established validation/partial/submitted outcomes even if the
      // caller signal expired while an injected operation ignored cancellation.
      if (!isRetryableError(error)) throw error;
      if (signal?.aborted) throw abortReason(signal);

      // Check if we should retry
      const isLastAttempt = attempt === config.maxRetries;
      if (isLastAttempt) {
        throw error;
      }

      // Calculate backoff delay
      const delayMs = calculateBackoff(
        attempt,
        config.baseDelayMs,
        config.maxDelayMs,
      );

      // Notify callback if provided
      if (options.onRetry) {
        options.onRetry(error, attempt + 1, delayMs);
      }

      // Wait before retrying
      await abortableSleep(delayMs, signal);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}
