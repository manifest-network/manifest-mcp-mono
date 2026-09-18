import { describe, expect, it, vi } from 'vitest';
import { isRetryableError, retryInspectionFails, withRetry } from './retry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

function transientError(): ManifestMCPError {
  return new ManifestMCPError(
    ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    'connect ECONNREFUSED 127.0.0.1:26657',
  );
}

function unreadableProperty(property: string): Error {
  return Object.defineProperty(transientError(), property, {
    get() {
      throw new Error(`Cannot inspect ${property}`);
    },
  });
}

const unreadableErrors = [
  { name: 'cause getter', create: () => unreadableProperty('cause') },
  {
    name: 'cause membership trap',
    create: () =>
      new Proxy(transientError(), {
        has(target, property) {
          if (property === 'cause')
            throw new Error('Cannot inspect membership');
          return Reflect.has(target, property);
        },
      }),
  },
  {
    name: 'prototype trap',
    create: () =>
      new Proxy(transientError(), {
        getPrototypeOf() {
          throw new Error('Cannot inspect prototype');
        },
      }),
  },
  {
    name: 'revoked proxy',
    create: () => {
      const { proxy, revoke } = Proxy.revocable(transientError(), {});
      revoke();
      return proxy;
    },
  },
  { name: 'message getter', create: () => unreadableProperty('message') },
  { name: 'code getter', create: () => unreadableProperty('code') },
  { name: 'details getter', create: () => unreadableProperty('details') },
  { name: 'name getter', create: () => unreadableProperty('name') },
];

describe('retry error inspection', () => {
  it('retains inspection-failure provenance for unreadable maintenance context', () => {
    const error = Object.assign(new Error('HTTP 503'), {
      details: Object.defineProperty({}, 'operation', {
        get() {
          throw new Error('Cannot inspect command ownership');
        },
      }),
    });

    expect(retryInspectionFails(error)).toBe(true);
    expect(isRetryableError(error)).toBe(false);
  });

  it('does not mark established maintenance ownership as failed inspection', () => {
    const readCause = vi.fn(() => {
      throw new Error('Must not inspect diagnostic cause');
    });
    const command = Object.assign(new Error('HTTP 503'), {
      details: {
        operation: 'restart',
        outcome: 'accepted',
        idempotency_key: 'persisted-command',
      },
    });
    Object.defineProperty(command, 'cause', { get: readCause });
    const error = Object.assign(new Error('fetch failed'), { cause: command });

    expect(retryInspectionFails(error)).toBe(false);
    expect(isRetryableError(error)).toBe(false);
    expect(readCause).not.toHaveBeenCalled();
  });

  it.each([
    {
      verdict: 'permanent transport message',
      create: () => new Error('getaddrinfo ENOTFOUND invalid.example'),
    },
    {
      verdict: 'permanent HTTP status',
      create: () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'fetch failed',
          {
            httpStatus: 403,
          },
        ),
    },
    {
      verdict: 'permanent code',
      create: () =>
        new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'fetch failed'),
    },
    {
      verdict: 'submitted outcome',
      create: () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
          'fetch failed',
          { sent: true },
        ),
    },
    {
      verdict: 'partial outcome',
      create: () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'fetch failed',
          { partial: true },
        ),
    },
  ])('does not inspect causes behind an outer $verdict', async ({ create }) => {
    const cause = vi.fn(() => {
      throw new Error('Must not inspect');
    });
    const error = Object.defineProperty(create(), 'cause', { get: cause });
    const operation = vi.fn(async () => {
      throw error;
    });
    const onRetry = vi.fn();
    expect(isRetryableError(error)).toBe(false);
    await expect(
      withRetry(operation, {
        config: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
        onRetry,
      }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    expect(cause).not.toHaveBeenCalled();
  });

  describe.each(unreadableErrors)('$name', ({ create }) => {
    it.each([false, true])(
      'preserves the original failure without retrying (nested: %s)',
      async (nested) => {
        const unreadable = create();
        const error = nested
          ? Object.assign(transientError(), { cause: unreadable })
          : unreadable;

        expect(isRetryableError(error)).toBe(false);
        for (const maxRetries of [0, 2]) {
          const operation = vi.fn(async () => {
            throw error;
          });
          const onRetry = vi.fn();
          // Compare in the rejection handler: resolving a revoked proxy as a
          // promise value would itself attempt to read its `then` property.
          const originalPreserved = await withRetry(operation, {
            config: { maxRetries, baseDelayMs: 1, maxDelayMs: 1 },
            onRetry,
          }).then(
            () => false,
            (caught: unknown) => caught === error,
          );
          expect(originalPreserved).toBe(true);
          expect(operation).toHaveBeenCalledOnce();
          expect(onRetry).not.toHaveBeenCalled();
        }
      },
    );
  });

  it('preserves a later unreadable failure after an earlier readable retry', async () => {
    const first = transientError();
    const last = unreadableProperty('cause');
    const operation = vi
      .fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValue(last);
    const onRetry = vi.fn();
    const originalPreserved = await withRetry(operation, {
      config: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 },
      onRetry,
    }).then(
      () => false,
      (caught: unknown) => caught === last,
    );
    expect(originalPreserved).toBe(true);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(
      first,
      1,
      expect.any(Number),
    );
  });

  it('does not authorize an owned timeout from an unreadable cause chain', () => {
    const error = Object.assign(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'Read deadline', {
        transportCode: 'ETIMEDOUT',
      }),
      { cause: unreadableProperty('cause') },
    );
    expect(isRetryableError(error)).toBe(false);
  });

  it('preserves an unreadable failure if the operation also cancels its caller', async () => {
    const controller = new AbortController();
    const error = unreadableProperty('cause');
    const operation = vi.fn(async () => {
      controller.abort('Caller stopped');
      throw error;
    });
    const onRetry = vi.fn();
    await expect(
      withRetry(operation, { signal: controller.signal, onRetry }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not inspect an error after the caller signal has already aborted', () => {
    const controller = new AbortController();
    controller.abort('Caller stopped');
    const getPrototypeOf = vi.fn(() => {
      throw new Error('Must not inspect');
    });
    const error = new Proxy(new Error('fetch failed'), { getPrototypeOf });
    expect(isRetryableError(error, { signal: controller.signal })).toBe(false);
    expect(getPrototypeOf).not.toHaveBeenCalled();
  });

  it('still retries a readable transient cyclic cause chain', async () => {
    const error: Error & { cause?: unknown } = new Error('Opaque wrapper');
    const cause = Object.assign(transientError(), { cause: error });
    error.cause = cause;
    const operation = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue('recovered');
    const onRetry = vi.fn();
    expect(isRetryableError(error)).toBe(true);
    await expect(
      withRetry(operation, {
        config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        onRetry,
      }),
    ).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]?.[0]).toBe(error);
    expect(error.cause).toBe(cause);
    expect(cause.cause).toBe(error);
  });
});
