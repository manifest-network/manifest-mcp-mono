import { ManifestMCPError, ManifestMCPErrorCode, RetryConfig } from './types.js';

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
  ManifestMCPErrorCode.MISSING_CONFIG,

  // Wallet errors - require user action
  ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
  ManifestMCPErrorCode.INVALID_MNEMONIC,

  // Validation errors - input is invalid
  ManifestMCPErrorCode.INVALID_ADDRESS,
  ManifestMCPErrorCode.UNSUPPORTED_TX,
  ManifestMCPErrorCode.UNSUPPORTED_QUERY,
  ManifestMCPErrorCode.UNKNOWN_MODULE,
  ManifestMCPErrorCode.UNKNOWN_SUBCOMMAND,

  // Transaction failures due to validation - won't change on retry
  ManifestMCPErrorCode.INSUFFICIENT_FUNDS,
];

/**
 * Check if an error message indicates a transient failure that should be retried
 */
function isTransientErrorMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // Network-level errors
  if (
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('etimedout') ||
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('network') ||
    lowerMessage.includes('socket') ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('connection')
  ) {
    return true;
  }

  // HTTP 5xx errors (server-side issues)
  if (
    lowerMessage.includes('500') ||
    lowerMessage.includes('502') ||
    lowerMessage.includes('503') ||
    lowerMessage.includes('504') ||
    lowerMessage.includes('internal server error') ||
    lowerMessage.includes('bad gateway') ||
    lowerMessage.includes('service unavailable') ||
    lowerMessage.includes('gateway timeout')
  ) {
    return true;
  }

  // Rate limiting (should be handled by rate limiter, but retry if we hit it anyway)
  if (lowerMessage.includes('429') || lowerMessage.includes('too many requests')) {
    return true;
  }

  return false;
}

/**
 * Determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  // ManifestMCPError with non-retryable code
  if (error instanceof ManifestMCPError) {
    if (NON_RETRYABLE_ERROR_CODES.includes(error.code)) {
      return false;
    }
    // Check message for transient indicators
    return isTransientErrorMessage(error.message);
  }

  // Standard Error - check message
  if (error instanceof Error) {
    return isTransientErrorMessage(error.message);
  }

  // Unknown error type - don't retry
  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap
 * @returns Delay in milliseconds
 */
export function calculateBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter (±25% randomization to prevent thundering herd)
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);

  return Math.floor(cappedDelay + jitter);
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Options for the retry wrapper
 */
export interface RetryOptions {
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
  options: RetryOptions = {}
): Promise<T> {
  const config = {
    ...DEFAULT_RETRY_CONFIG,
    ...options.config,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const isLastAttempt = attempt === config.maxRetries;
      const shouldRetry = !isLastAttempt && isRetryableError(error);

      if (!shouldRetry) {
        throw error;
      }

      // Calculate backoff delay
      const delayMs = calculateBackoff(attempt, config.baseDelayMs, config.maxDelayMs);

      // Notify callback if provided
      if (options.onRetry) {
        options.onRetry(error, attempt + 1, delayMs);
      }

      // Wait before retrying
      await sleep(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}
