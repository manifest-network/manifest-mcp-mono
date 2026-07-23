import { describe, expect, it, vi } from 'vitest';
import {
  calculateBackoff,
  DEFAULT_RETRY_CONFIG,
  isRetryableError,
  withRetry,
} from './retry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

describe('isRetryableError', () => {
  describe('ManifestMCPError handling', () => {
    it('should not retry INVALID_CONFIG errors', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Invalid config',
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not retry INVALID_ADDRESS errors', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_ADDRESS,
        'Invalid address',
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not retry WALLET_NOT_CONNECTED errors', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet not connected',
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not retry RESTORE_ORPHAN_COMPENSATION_FAILED even when the message embeds "HTTP 500" (ENG-599)', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
        'Restore left an orphaned lease; cause: request failed HTTP 500',
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not auto-retry any RESTORE_* code (restore_app is non-idempotent)', () => {
      // RESTORE_RETRYABLE included: "retryable" means the AGENT may re-invoke,
      // NOT that withRetry should auto-re-broadcast (that would re-create a lease).
      // Its "HTTP 503" message must not slip through the 5xx sniff either.
      for (const err of [
        new ManifestMCPError(ManifestMCPErrorCode.RESTORE_NOT_RETAINED, 'x'),
        new ManifestMCPError(ManifestMCPErrorCode.RESTORE_REJECTED, 'x'),
        new ManifestMCPError(
          ManifestMCPErrorCode.RESTORE_RETRYABLE,
          'Restore rejected (HTTP 503); rolled back',
        ),
      ]) {
        expect(isRetryableError(err)).toBe(false);
      }
    });

    it('should retry RPC_CONNECTION_FAILED with network error message', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        'Connection refused: ECONNREFUSED',
      );
      expect(isRetryableError(error)).toBe(true);
    });

    it('should retry QUERY_FAILED with timeout message', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'Request timed out after 30000ms',
      );
      expect(isRetryableError(error)).toBe(true);
    });

    it('should not retry TX_FAILED errors (non-idempotent)', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'Service unavailable (503)',
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not retry GAS_LIMIT_EXCEEDED errors', () => {
      // Transient-looking message on purpose: the ONLY reason this returns false
      // is the NON_RETRYABLE_ERROR_CODES short-circuit (ENG-556). If the code were
      // dropped from that set, isTransientErrorMessage('...503...') would make it retry.
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
        'Service unavailable (503)',
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('exposes GAS_LIMIT_EXCEEDED as a stable enum value', () => {
      expect(ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED).toBe(
        'GAS_LIMIT_EXCEEDED',
      );
    });

    it('should not retry OPERATION_CANCELLED errors', () => {
      // A deliberate user decline / cancel / elicitation-timeout (ENG-272).
      // The transient-looking message must NOT override the non-retryable
      // code classification — retrying a user's cancel is nonsensical.
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
        'User cancelled (timed out)',
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('treats SKU_AMBIGUOUS as non-retryable (needs caller disambiguation)', () => {
      const err = new ManifestMCPError(
        ManifestMCPErrorCode.SKU_AMBIGUOUS,
        'multiple SKUs named docker-micro',
      );
      expect(isRetryableError(err)).toBe(false);
    });
  });

  describe('Standard Error handling', () => {
    it('should retry network errors', () => {
      expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRetryableError(new Error('ENOTFOUND'))).toBe(true);
    });

    it('should retry timeout errors', () => {
      expect(isRetryableError(new Error('Request timed out'))).toBe(true);
      expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    });

    it('should retry 5xx HTTP errors with descriptive messages', () => {
      expect(isRetryableError(new Error('Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('Bad Gateway'))).toBe(true);
      expect(isRetryableError(new Error('Service Unavailable'))).toBe(true);
      expect(isRetryableError(new Error('Gateway Timeout'))).toBe(true);
      expect(isRetryableError(new Error('HTTP 502'))).toBe(true);
      expect(isRetryableError(new Error('status 503'))).toBe(true);
    });

    it('should not retry errors with bare numbers that are not HTTP status codes', () => {
      expect(isRetryableError(new Error('proposal 500 not found'))).toBe(false);
      expect(isRetryableError(new Error('account sequence 503'))).toBe(false);
    });

    it('should retry rate limit errors', () => {
      expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
    });

    it('does NOT retry a cosmjs broadcast-confirmation timeout (submitted-but-not-found ⇒ no re-broadcast)', () => {
      // Verbatim @cosmjs/stargate TimeoutError message — must NOT match any transient pattern in retry.ts
      // (notably it contains NO "timed out"/"timeout"/"etimedout" substring, unlike a network ETIMEDOUT).
      const err = new Error(
        'Transaction with ID ABCDEF was submitted but was not yet found on the chain. ' +
          'You might want to check later. There was a wait of 30 seconds.',
      );
      expect(isRetryableError(err)).toBe(false);
    });

    it('should not retry generic errors without transient indicators', () => {
      expect(isRetryableError(new Error('Something went wrong'))).toBe(false);
      expect(isRetryableError(new Error('Invalid input'))).toBe(false);
    });
  });

  describe('Unknown error types', () => {
    it('should not retry non-Error objects', () => {
      expect(isRetryableError('string error')).toBe(false);
      expect(isRetryableError(123)).toBe(false);
      expect(isRetryableError(null)).toBe(false);
      expect(isRetryableError(undefined)).toBe(false);
      expect(isRetryableError({ message: 'object error' })).toBe(false);
    });
  });
});

describe('calculateBackoff', () => {
  it('should return base delay for first attempt', () => {
    const delay = calculateBackoff(0, 1000, 10000);
    // With jitter, should be within ±25% of 1000
    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it('should double delay for each attempt', () => {
    // Attempt 1: 2000ms base
    const delay1 = calculateBackoff(1, 1000, 10000);
    expect(delay1).toBeGreaterThanOrEqual(1500);
    expect(delay1).toBeLessThanOrEqual(2500);

    // Attempt 2: 4000ms base
    const delay2 = calculateBackoff(2, 1000, 10000);
    expect(delay2).toBeGreaterThanOrEqual(3000);
    expect(delay2).toBeLessThanOrEqual(5000);
  });

  it('should cap delay at maxDelayMs', () => {
    // Attempt 10 would be 1024000ms without cap
    const delay = calculateBackoff(10, 1000, 10000);
    // With jitter, should be within ±25% of 10000
    expect(delay).toBeGreaterThanOrEqual(7500);
    expect(delay).toBeLessThanOrEqual(12500);
  });

  it('should handle zero base delay', () => {
    const delay = calculateBackoff(0, 0, 10000);
    expect(delay).toBe(0);
  });
});

describe('withRetry', () => {
  it('should return result on success', async () => {
    const operation = vi.fn().mockResolvedValue('success');
    const result = await withRetry(operation);
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should not retry on non-retryable error', async () => {
    const error = new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      'Invalid address',
    );
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withRetry(operation)).rejects.toThrow(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable error and eventually succeed', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('success');

    const result = await withRetry(operation, {
      config: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
    });

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries exhausted', async () => {
    const error = new Error('ECONNREFUSED');
    const operation = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(operation, {
        config: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 },
      }),
    ).rejects.toThrow(error);

    // Initial attempt + 2 retries = 3 calls
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should call onRetry callback before each retry', async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('success');

    await withRetry(operation, {
      config: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 },
      onRetry,
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.any(Error),
      1, // attempt number
      expect.any(Number), // delay
    );
  });

  it('should use default config when not provided', async () => {
    const operation = vi.fn().mockResolvedValue('success');
    await withRetry(operation);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should respect maxRetries: 0 (no retries)', async () => {
    const error = new Error('ECONNREFUSED');
    const operation = vi.fn().mockRejectedValue(error);

    await expect(
      withRetry(operation, {
        config: { maxRetries: 0, baseDelayMs: 10, maxDelayMs: 100 },
      }),
    ).rejects.toThrow(error);

    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('DEFAULT_RETRY_CONFIG', () => {
  it('should have sensible defaults', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(1000);
    expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(10000);
  });
});

describe('INVALID_ARGUMENT is a non-retryable input error', () => {
  it('exists on the enum', () => {
    expect(ManifestMCPErrorCode.INVALID_ARGUMENT).toBe('INVALID_ARGUMENT');
  });
  it('is classified non-retryable', () => {
    const err = new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ARGUMENT,
      'bad',
    );
    expect(isRetryableError(err)).toBe(false);
  });
});

describe('isRetryableError — structured details (ENG-536)', () => {
  it('never retries NOT_FOUND', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(
          ManifestMCPErrorCode.NOT_FOUND,
          'lease not found',
          {
            httpStatus: 404,
            grpcCode: 5,
          },
        ),
      ),
    ).toBe(false);
  });

  // Pins the original bug: axios's real message template defeats the 5xx pattern.
  // No envelope => a genuine transport/proxy 5xx => retry.
  it('retries an UNENVELOPED 5xx despite the "status code 500" message', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'LCD query "lease" failed: Request failed with status code 500',
          { httpStatus: 500 },
        ),
      ),
    ).toBe(true);
  });

  // THE regression guard. wasm/group not-founds arrive as 500 + code:2 (verified
  // live). The chain ANSWERED — retrying cannot change "no such code".
  it('does NOT retry an ENVELOPED 5xx (deterministic keeper answer)', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'LCD query "code" failed: Request failed with status code 500',
          {
            httpStatus: 500,
            grpcCode: 2,
            grpcMessage: 'codespace wasm code 28: no such code: code id 999999',
          },
        ),
      ),
    ).toBe(false);
  });

  // An enveloped code the chain itself marks transient.
  it('retries an enveloped UNAVAILABLE (grpc 14)', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'node catching up',
          {
            httpStatus: 503,
            grpcCode: 14,
          },
        ),
      ),
    ).toBe(true);
  });

  it('does not retry a 4xx carrying details', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'bad request', {
          httpStatus: 400,
        }),
      ),
    ).toBe(false);
  });

  it('still retries an unenveloped 429', () => {
    expect(
      isRetryableError(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'rate limited',
          {
            httpStatus: 429,
          },
        ),
      ),
    ).toBe(true);
  });
});
