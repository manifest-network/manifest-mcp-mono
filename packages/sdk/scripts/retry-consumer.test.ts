import {
  isRetryableError,
  ManifestMCPError,
  ManifestMCPErrorCode,
  withRetry,
} from '@manifest-network/manifest-sdk';
import { fetchFaucetStatus } from '@manifest-network/manifest-sdk/faucet';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Public package specifiers exercise the built exports map and dependency identity.
// Requires the SDK and its pinned siblings built first; every fetch is injected.
afterEach(() => vi.restoreAllMocks());

describe('SDK-only retry consumer', () => {
  it('recognizes the faucet producer error instance and retries its owned deadline', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
    const status = {
      status: 'ok',
      nodeUrl: 'https://rpc.example.com',
      chainId: 'manifest-test',
      chainTokens: ['umfx'],
      availableTokens: ['umfx'],
      holder: { address: 'manifest1faucet', balance: [] },
      distributors: [],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => {
        deadline.abort(
          new DOMException(
            'The operation was aborted due to timeout',
            'TimeoutError',
          ),
        );
        throw deadline.signal.reason;
      })
      .mockResolvedValueOnce(Response.json(status));
    const onRetry = vi.fn();

    await expect(
      withRetry(() => fetchFaucetStatus('https://faucet.example.com', fetch), {
        config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        onRetry,
      }),
    ).resolves.toEqual(status);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    const error: unknown = onRetry.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(ManifestMCPError);
    expect(error).toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      details: { transportCode: 'ETIMEDOUT' },
    });
    expect(isRetryableError(error)).toBe(true);
  });

  it('preserves a faucet HTTP rejection despite transient-looking provider text', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('Request timed out; HTTP 503', { status: 403 }),
    );
    const onRetry = vi.fn();
    await expect(
      withRetry(() => fetchFaucetStatus('https://faucet.example.com', fetch), {
        config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        onRetry,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      details: { httpStatus: 403 },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
