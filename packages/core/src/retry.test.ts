import { describe, it, expect, vi } from 'vitest';
import {
  isRetryableError,
  calculateBackoff,
  withRetry,
  DEFAULT_RETRY_CONFIG,
} from './retry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

describe('isRetryableError', () => {
  describe('ManifestMCPError handling', () => {
    it('should not retry INVALID_CONFIG errors', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Invalid config'
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not retry INVALID_ADDRESS errors', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_ADDRESS,
        'Invalid address'
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not retry INSUFFICIENT_FUNDS errors', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.INSUFFICIENT_FUNDS,
        'Insufficient funds'
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should not retry WALLET_NOT_CONNECTED errors', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet not connected'
      );
      expect(isRetryableError(error)).toBe(false);
    });

    it('should retry RPC_CONNECTION_FAILED with network error message', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        'Connection refused: ECONNREFUSED'
      );
      expect(isRetryableError(error)).toBe(true);
    });

    it('should retry QUERY_FAILED with timeout message', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'Request timeout after 30000ms'
      );
      expect(isRetryableError(error)).toBe(true);
    });

    it('should retry TX_FAILED with 503 error', () => {
      const error = new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'Service unavailable (503)'
      );
      expect(isRetryableError(error)).toBe(true);
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
      expect(isRetryableError(new Error('timeout'))).toBe(true);
      expect(isRetryableError(new Error('Request timed out'))).toBe(true);
    });

    it('should retry 5xx HTTP errors', () => {
      expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('502 Bad Gateway'))).toBe(true);
      expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
      expect(isRetryableError(new Error('504 Gateway Timeout'))).toBe(true);
    });

    it('should retry rate limit errors', () => {
      expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
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
      'Invalid address'
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
      })
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
      expect.any(Number) // delay
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
      })
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
