import { describe, expectTypeOf, it } from 'vitest';
import { type FaucetStatusResponse, fetchFaucetStatus } from './faucet.js';
import {
  isRetryableError,
  type RetryOptions,
  type TransportErrorDetails,
  withRetry,
} from './index.js';

describe('public retry API (type-level)', () => {
  it('accepts optional caller signals without changing classifier arguments or result', () => {
    expectTypeOf<Pick<RetryOptions, 'signal'>>().toEqualTypeOf<{
      signal?: AbortSignal;
    }>();
    expectTypeOf(isRetryableError).parameters.toEqualTypeOf<
      [error: unknown, options?: { signal?: AbortSignal }]
    >();
    expectTypeOf(isRetryableError).returns.toEqualTypeOf<boolean>();
  });

  it('exports an optional, exact transport timeout marker', () => {
    expectTypeOf<TransportErrorDetails>().toEqualTypeOf<{
      readonly transportCode?: 'ETIMEDOUT';
    }>();
    expectTypeOf<{
      transportCode: 'TimeoutError';
    }>().not.toExtend<TransportErrorDetails>();
  });

  it('infers the faucet response in the documented cancellation composition', () => {
    // This function is never invoked: only its inferred public return type is checked.
    function faucetStatusExample(faucetUrl: string, signal: AbortSignal) {
      const fetchWithCancellation: typeof globalThis.fetch = (input, init) =>
        globalThis.fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        });

      return withRetry(
        () => fetchFaucetStatus(faucetUrl, fetchWithCancellation),
        { signal, config: { maxRetries: 2 }, operationName: 'faucet status' },
      );
    }
    expectTypeOf(faucetStatusExample).returns.toEqualTypeOf<
      Promise<FaucetStatusResponse>
    >();
  });
});
