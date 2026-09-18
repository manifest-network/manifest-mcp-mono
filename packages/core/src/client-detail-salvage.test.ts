import { afterEach, expect, it, vi } from 'vitest';
import { CosmosClientManager } from './client.js';
import { cosmosQuery } from './cosmos.js';
import { createLCDQueryClient } from './lcd-adapter.js';
import { isRetryableError, withRetry } from './retry.js';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type WalletProvider,
} from './types.js';

// REST is the only configured transport. An identity failure must never reach
// adapter construction; the injected fetch and this stub seal both IO seams.
vi.mock('./lcd-adapter.js', () => ({
  createLCDQueryClient: vi.fn(() => {
    throw new Error('Unexpected LCD transport construction');
  }),
}));

afterEach(() => CosmosClientManager.clearInstances());

it('salvages an own HTTP verdict when a details proxy blocks property reads', async () => {
  const details = new Proxy(
    { httpStatus: 403 },
    {
      get() {
        throw new Error('Property reads are unavailable');
      },
    },
  );
  const original = new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    'fetch failed',
    details,
  );
  const chainIdentityFetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValue(original);
  const endpoint = 'https://rest.example.com/chain';
  const retry = { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 };
  const wallet: WalletProvider = {
    getAddress: vi.fn(() => {
      throw new Error('Unexpected wallet address request');
    }),
    getSigner: vi.fn(() => {
      throw new Error('Unexpected wallet signer request');
    }),
  };
  const manager = CosmosClientManager.getInstance(
    { chainId: 'test-chain', restUrl: endpoint, retry },
    wallet,
    chainIdentityFetch,
  );
  const onRetry = vi.fn();

  // Exercise manager repair, real Cosmos attribution, and a caller's retry
  // boundary. Checking terminality alone would miss loss of useful diagnostics.
  const error: unknown = await withRetry(
    () => cosmosQuery(manager, 'bank', 'balances'),
    { config: retry, onRetry },
  ).catch((error: unknown) => error);

  expect(error).toBeInstanceOf(ManifestMCPError);
  expect(error).toMatchObject({
    code: ManifestMCPErrorCode.QUERY_FAILED,
    message: 'fetch failed',
    details: {
      httpStatus: 403,
      url: endpoint,
      module: 'bank',
      subcommand: 'balances',
    },
  });
  expect(isRetryableError(error)).toBe(false);
  expect(chainIdentityFetch).toHaveBeenCalledOnce();
  expect(createLCDQueryClient).not.toHaveBeenCalled();
  expect(wallet.getAddress).not.toHaveBeenCalled();
  expect(wallet.getSigner).not.toHaveBeenCalled();
  expect(onRetry).not.toHaveBeenCalled();
});
