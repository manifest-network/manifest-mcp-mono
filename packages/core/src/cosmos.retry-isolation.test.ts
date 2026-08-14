import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/**
 * ENG-679 regression guard: client acquisition must live OUTSIDE the call-site
 * retry ladder.
 *
 * `CosmosClientManager.getQueryClient` / `getSigningClient` already retry the
 * connect internally (`client.ts` initQueryClient/initSigningClient), and the RPC
 * branch builds FIVE namespace clients per attempt. When `cosmos.ts` acquired the
 * client *inside* its own `withRetry`, the two ladders multiplied: 4 outer x 4
 * inner x 5 sockets = 77 connects / ~35s on a dead endpoint (measured), which blew
 * the 30s budget of `e2e/retry.e2e.test.ts`. The nesting had been latent since the
 * ladders were written — a rejected-init promise that latched forever made outer
 * attempts 2-4 re-await the cached rejection instantly, and ENG-636 correctly
 * removed that latch, exposing the amplification.
 *
 * This file deliberately does NOT mock `./retry.js` — `cosmos.test.ts` stubs
 * `withRetry` to a passthrough (correct for its purpose: fast handler-dispatch
 * tests), which makes it structurally blind to nesting. Here the REAL ladder runs
 * with a 1ms base delay, so a re-introduced nested acquisition shows up as an
 * acquisition call count of 4 instead of 1.
 */

vi.mock('./modules.js', () => ({
  getQueryHandler: vi.fn(),
  getTxHandler: vi.fn(),
  getTxMsgBuilder: vi.fn(),
  getTxContextLoader: vi.fn(),
}));

import { cosmosEstimateFee, cosmosQuery, cosmosTx } from './cosmos.js';
import {
  getQueryHandler,
  getTxContextLoader,
  getTxHandler,
  getTxMsgBuilder,
} from './modules.js';

const mockGetQueryHandler = vi.mocked(getQueryHandler);
const mockGetTxHandler = vi.mocked(getTxHandler);
const mockGetTxMsgBuilder = vi.mocked(getTxMsgBuilder);
const mockGetTxContextLoader = vi.mocked(getTxContextLoader);

/** Four attempts (maxRetries 3) with a ~1ms backoff instead of 1s/2s/4s. */
const FAST_RETRY = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 };
const EXPECTED_ATTEMPTS = FAST_RETRY.maxRetries + 1;

/** A message `isTransientErrorMessage` classifies as retryable. */
const TRANSIENT = 'fetch failed';

/** What a dead endpoint produces once `initQueryClient`'s own ladder is exhausted. */
function connectFailure(): ManifestMCPError {
  return new ManifestMCPError(
    ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    `Failed to connect to RPC endpoint: ${TRANSIENT} (ECONNREFUSED 127.0.0.1:9)`,
    { url: 'http://127.0.0.1:9' },
  );
}

function makeMockClientManager() {
  const cm = {
    acquireRateLimit: vi.fn().mockResolvedValue(undefined),
    getQueryClient: vi.fn().mockResolvedValue({ mock: 'queryClient' }),
    getSigningClient: vi.fn().mockResolvedValue({
      simulate: vi.fn().mockResolvedValue(100_000),
      defaultGasMultiplier: 1.5,
    }),
    getBroadcastClient: vi.fn(() => cm.getSigningClient()),
    getAddress: vi.fn().mockResolvedValue('manifest1sender'),
    getConfig: vi
      .fn()
      .mockReturnValue({ retry: FAST_RETRY, gasPrice: '0.001umfx' }),
    withBroadcastLock: vi
      .fn()
      .mockImplementation(<T>(_addr: string, fn: () => Promise<T>) => fn()),
    disconnect: vi.fn(),
    // Test double for CosmosClientManager — same shape as cosmos.test.ts's.
  } as any;
  return cm;
}

describe('client acquisition is outside the call-site retry ladder (ENG-679)', () => {
  let clientManager: ReturnType<typeof makeMockClientManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    clientManager = makeMockClientManager();
    mockGetTxContextLoader.mockReturnValue(undefined);
  });

  describe('cosmosQuery', () => {
    it('acquires the query client ONCE while the handler leg still retries', async () => {
      const handler = vi.fn().mockRejectedValue(new Error(TRANSIENT));
      mockGetQueryHandler.mockReturnValue(handler);

      await expect(
        cosmosQuery(clientManager, 'bank', 'params'),
      ).rejects.toThrow(/Query bank params failed/);

      expect(clientManager.getQueryClient).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(EXPECTED_ATTEMPTS);
      // One rate-limit token per RPC attempt — the token is a request budget,
      // not a connection budget, so it stays inside the ladder.
      expect(clientManager.acquireRateLimit).toHaveBeenCalledTimes(
        EXPECTED_ATTEMPTS,
      );
    });

    it('does not re-run a failed acquisition, and keeps {module, subcommand} attribution', async () => {
      clientManager.getQueryClient.mockRejectedValue(connectFailure());
      mockGetQueryHandler.mockReturnValue(vi.fn());

      await expect(
        cosmosQuery(clientManager, 'bank', 'params'),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        details: {
          module: 'bank',
          subcommand: 'params',
          url: expect.any(String),
        },
      });

      expect(clientManager.getQueryClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('cosmosTx load-context leg', () => {
    beforeEach(() => {
      mockGetTxHandler.mockReturnValue(vi.fn().mockResolvedValue({ ok: true }));
    });

    it('acquires the query client ONCE while the loader still retries', async () => {
      const loader = vi.fn().mockRejectedValue(new Error(TRANSIENT));
      mockGetTxContextLoader.mockReturnValue(loader);

      await expect(
        cosmosTx(clientManager, 'billing', 'create-lease'),
      ).rejects.toThrow(/Failed to load build context/);

      expect(clientManager.getQueryClient).toHaveBeenCalledTimes(1);
      expect(loader).toHaveBeenCalledTimes(EXPECTED_ATTEMPTS);
    });

    it('does not re-run a failed acquisition', async () => {
      mockGetTxContextLoader.mockReturnValue(vi.fn());
      clientManager.getQueryClient.mockRejectedValue(connectFailure());

      await expect(
        cosmosTx(clientManager, 'billing', 'create-lease'),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        details: { module: 'billing', subcommand: 'create-lease' },
      });

      expect(clientManager.getQueryClient).toHaveBeenCalledTimes(1);
    });

    it('skips acquisition entirely when no loader is registered', async () => {
      mockGetTxContextLoader.mockReturnValue(undefined);

      await cosmosTx(clientManager, 'bank', 'send');

      expect(clientManager.getQueryClient).not.toHaveBeenCalled();
    });
  });

  describe('cosmosTx broadcast leg', () => {
    it('acquires the broadcast client ONCE while the handler leg still retries', async () => {
      // The handler must throw a ManifestMCPError: enrichTxError maps a RAW throw to
      // the non-retryable TX_FAILED (double-broadcast guard), so a plain Error would
      // fail fast and prove nothing about the ladder.
      const handler = vi
        .fn()
        .mockRejectedValue(
          new ManifestMCPError(
            ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
            TRANSIENT,
          ),
        );
      mockGetTxHandler.mockReturnValue(handler);

      await expect(
        cosmosTx(clientManager, 'bank', 'send'),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      });

      expect(clientManager.getBroadcastClient).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(EXPECTED_ATTEMPTS);
      expect(clientManager.acquireRateLimit).toHaveBeenCalledTimes(
        EXPECTED_ATTEMPTS,
      );
    });

    it('does not re-run a failed acquisition, and keeps tx attribution', async () => {
      mockGetTxHandler.mockReturnValue(vi.fn());
      clientManager.getBroadcastClient.mockRejectedValue(connectFailure());

      await expect(
        cosmosTx(clientManager, 'bank', 'send'),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        details: { module: 'bank', subcommand: 'send', args: [] },
      });

      expect(clientManager.getBroadcastClient).toHaveBeenCalledTimes(1);
      // The lock is still acquired exactly once around the whole cycle.
      expect(clientManager.withBroadcastLock).toHaveBeenCalledTimes(1);
    });
  });

  describe('cosmosEstimateFee', () => {
    it('acquires the signing client ONCE while the simulate leg still retries', async () => {
      const simulate = vi.fn().mockRejectedValue(new Error(TRANSIENT));
      clientManager.getSigningClient.mockResolvedValue({
        simulate,
        defaultGasMultiplier: 1.5,
      });
      mockGetTxMsgBuilder.mockReturnValue(
        vi.fn().mockReturnValue({ messages: [], memo: '' }),
      );

      await expect(
        cosmosEstimateFee(clientManager, 'bank', 'send'),
      ).rejects.toThrow(/Fee estimation for bank send failed/);

      expect(clientManager.getSigningClient).toHaveBeenCalledTimes(1);
      expect(simulate).toHaveBeenCalledTimes(EXPECTED_ATTEMPTS);
    });

    it('does not re-run a failed acquisition', async () => {
      clientManager.getSigningClient.mockRejectedValue(connectFailure());
      mockGetTxMsgBuilder.mockReturnValue(vi.fn());

      await expect(
        cosmosEstimateFee(clientManager, 'bank', 'send'),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        details: { module: 'bank', subcommand: 'send' },
      });

      expect(clientManager.getSigningClient).toHaveBeenCalledTimes(1);
    });
  });
});
