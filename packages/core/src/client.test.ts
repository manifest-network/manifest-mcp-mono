import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

// Mock external dependencies
vi.mock('@manifest-network/manifestjs', () => ({
  liftedinit: {
    ClientFactory: {
      createRPCQueryClient: vi.fn(),
    },
  },
  cosmwasm: {
    ClientFactory: {
      createRPCQueryClient: vi.fn().mockResolvedValue({ cosmwasm: {} }),
    },
  },
  strangelove_ventures: {
    ClientFactory: {
      createRPCQueryClient: vi
        .fn()
        .mockResolvedValue({ strangelove_ventures: {} }),
    },
  },
  osmosis: {
    ClientFactory: {
      createRPCQueryClient: vi.fn().mockResolvedValue({ osmosis: {} }),
    },
  },
  ibc: {
    ClientFactory: {
      createRPCQueryClient: vi.fn().mockResolvedValue({ ibc: {} }),
    },
  },
  cosmosProtoRegistry: [],
  cosmosAminoConverters: {},
  cosmwasmProtoRegistry: [],
  cosmwasmAminoConverters: {},
  liftedinitProtoRegistry: [],
  liftedinitAminoConverters: {},
  strangeloveVenturesProtoRegistry: [],
  strangeloveVenturesAminoConverters: {},
  osmosisProtoRegistry: [],
  osmosisAminoConverters: {},
  ibcProtoRegistry: [],
  ibcAminoConverters: {},
}));

vi.mock('@cosmjs/stargate', () => ({
  SigningStargateClient: {
    connectWithSigner: vi.fn().mockResolvedValue({ disconnect: vi.fn() }),
  },
  GasPrice: {
    fromString: vi.fn().mockReturnValue({}),
  },
  AminoTypes: class MockAminoTypes {},
}));

vi.mock('@cosmjs/proto-signing', () => ({
  Registry: class MockRegistry {},
}));

vi.mock('./lcd-adapter.js', () => ({
  createLCDQueryClient: vi.fn().mockResolvedValue({ mock: 'lcdClient' }),
}));

vi.mock('./retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retry.js')>();
  return {
    ...actual,
    withRetry: vi
      .fn()
      .mockImplementation(async (operation: () => Promise<unknown>) => {
        return operation();
      }),
  };
});

import { SigningStargateClient } from '@cosmjs/stargate';
import {
  cosmwasm as cosmwasmNs,
  liftedinit,
} from '@manifest-network/manifestjs';
import { CosmosClientManager } from './client.js';
import { createLCDQueryClient } from './lcd-adapter.js';
import { noopLogger } from './logger.js';
import type { ManifestMCPConfig, WalletProvider } from './types.js';

const mockCreateLCDQueryClient = vi.mocked(createLCDQueryClient);

const mockCreateRPCQueryClient = vi.mocked(
  liftedinit.ClientFactory.createRPCQueryClient,
);
const mockCreateCosmwasmRPCQueryClient = vi.mocked(
  cosmwasmNs.ClientFactory.createRPCQueryClient,
);
const mockConnectWithSigner = vi.mocked(
  SigningStargateClient.connectWithSigner,
);

function makeConfig(overrides?: Partial<ManifestMCPConfig>): ManifestMCPConfig {
  return {
    chainId: 'test-chain',
    rpcUrl: 'https://rpc.example.com',
    gasPrice: '1.0umfx',
    ...overrides,
  };
}

function makeWallet(overrides?: Partial<WalletProvider>): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('manifest1test'),
    getSigner: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeSpyLogger() {
  return { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
}

describe('CosmosClientManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CosmosClientManager.clearInstances();
    // Restore default mock return values after clearAllMocks
    mockCreateRPCQueryClient.mockResolvedValue({ mock: 'defaultQC' } as any);
    mockCreateCosmwasmRPCQueryClient.mockResolvedValue({
      cosmwasm: {},
    } as any);
    mockConnectWithSigner.mockResolvedValue({ disconnect: vi.fn() } as any);
  });

  afterEach(() => {
    CosmosClientManager.clearInstances();
  });

  describe('getInstance', () => {
    it('returns same instance for same chainId:rpcUrl', () => {
      const config = makeConfig();
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(config, wallet);
      const b = CosmosClientManager.getInstance(config, wallet);
      expect(a).toBe(b);
    });

    it('returns different instances for different rpcUrl', () => {
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(
        makeConfig({ rpcUrl: 'https://a.com' }),
        wallet,
      );
      const b = CosmosClientManager.getInstance(
        makeConfig({ rpcUrl: 'https://b.com' }),
        wallet,
      );
      expect(a).not.toBe(b);
    });

    it('returns different instances for different chainId', () => {
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'chain-a' }),
        wallet,
      );
      const b = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'chain-b' }),
        wallet,
      );
      expect(a).not.toBe(b);
    });

    it('invalidates signing client when gasPrice changes', async () => {
      const wallet = makeWallet();
      const client1 = { disconnect: vi.fn() };
      const client2 = { disconnect: vi.fn() };
      mockConnectWithSigner
        .mockResolvedValueOnce(client1 as any)
        .mockResolvedValueOnce(client2 as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '1.0umfx' }),
        wallet,
      );
      const sc1 = await instance.getSigningClient();
      expect(sc1).toBe(client1);

      // Re-get with different gasPrice — should create new signing client
      CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '2.0umfx' }),
        wallet,
      );
      const sc2 = await instance.getSigningClient();
      expect(sc2).toBe(client2);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('invalidates signing client when gasMultiplier changes', async () => {
      const wallet = makeWallet();
      const client1 = { disconnect: vi.fn() };
      const client2 = { disconnect: vi.fn() };
      mockConnectWithSigner
        .mockResolvedValueOnce(client1 as any)
        .mockResolvedValueOnce(client2 as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 1.5 }),
        wallet,
      );
      const sc1 = await instance.getSigningClient();
      expect(sc1).toBe(client1);

      // Re-get with different gasMultiplier — should create new signing client
      CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 2.5 }),
        wallet,
      );
      const sc2 = await instance.getSigningClient();
      expect(sc2).toBe(client2);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('invalidates signing client when walletProvider changes', async () => {
      const wallet1 = makeWallet();
      const wallet2 = makeWallet();

      const instance = CosmosClientManager.getInstance(makeConfig(), wallet1);
      await instance.getSigningClient();

      // Re-get with different wallet — should need new signing client
      CosmosClientManager.getInstance(makeConfig(), wallet2);
      await instance.getSigningClient();
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('does not invalidate signing client when only rate limit changes', async () => {
      const wallet = makeWallet();
      const config1 = makeConfig({ rateLimit: { requestsPerSecond: 10 } });
      const instance = CosmosClientManager.getInstance(config1, wallet);
      await instance.getSigningClient();

      const config2 = makeConfig({ rateLimit: { requestsPerSecond: 20 } });
      CosmosClientManager.getInstance(config2, wallet);
      await instance.getSigningClient();
      // Same signing client reused — only 1 call
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });
  });

  describe('getQueryClient', () => {
    it('creates and returns query client', async () => {
      const mockQC = { mock: 'queryClient' };
      mockCreateRPCQueryClient.mockResolvedValue(mockQC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const client1 = await instance.getQueryClient();
      const client2 = await instance.getQueryClient();

      expect(client1).toMatchObject(mockQC);
      expect(client1).toHaveProperty('cosmwasm');
      expect(client2).toBe(client1); // cached
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();
      expect(mockCreateCosmwasmRPCQueryClient).toHaveBeenCalledOnce();
    });

    it('deduplicates concurrent init calls', async () => {
      let resolveInit!: (value: any) => void;
      mockCreateRPCQueryClient.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInit = resolve;
          }) as any,
      );

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const p1 = instance.getQueryClient();
      const p2 = instance.getQueryClient();

      resolveInit({ mock: 'queryClient' });

      const [c1, c2] = await Promise.all([p1, p2]);
      expect(c1).toMatchObject({ mock: 'queryClient' });
      expect(c1).toHaveProperty('cosmwasm');
      expect(c2).toBe(c1);
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();
      expect(mockCreateCosmwasmRPCQueryClient).toHaveBeenCalledOnce();
    });

    it('wraps non-ManifestMCPError into RPC_CONNECTION_FAILED', async () => {
      mockCreateRPCQueryClient.mockRejectedValue(new Error('ECONNREFUSED'));

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        message: expect.stringContaining('ECONNREFUSED'),
      });
    });

    it('re-throws ManifestMCPError as-is', async () => {
      const original = new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        'custom',
      );
      mockCreateRPCQueryClient.mockRejectedValue(original);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await expect(instance.getQueryClient()).rejects.toBe(original);
    });

    // Note: Tests for retry-after-failure and disconnect-during-init are omitted
    // because the IIFE's thisInitPromise capture interacts subtly with vitest's
    // synchronous mock resolution. These code paths are covered by the e2e tests
    // against a live chain where async timing behaves naturally.
  });

  describe('getSigningClient', () => {
    it('overrides defaultGasMultiplier when property exists', async () => {
      const mockSC = { disconnect: vi.fn(), defaultGasMultiplier: 1.4 };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await instance.getSigningClient();

      expect(mockSC.defaultGasMultiplier).toBe(1.5);
    });

    it('applies custom gasMultiplier from config', async () => {
      const mockSC = { disconnect: vi.fn(), defaultGasMultiplier: 1.4 };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 2.5 }),
        makeWallet(),
      );
      await instance.getSigningClient();

      expect(mockSC.defaultGasMultiplier).toBe(2.5);
    });

    it('warns when defaultGasMultiplier is absent', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const spyLogger = makeSpyLogger();
      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      instance.setLogger(spyLogger);
      await instance.getSigningClient();
      expect((mockSC as any).defaultGasMultiplier).toBeUndefined();
      expect(spyLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not be applied'),
      );
    });

    it('warns with custom multiplier when defaultGasMultiplier is absent', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const spyLogger = makeSpyLogger();
      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasMultiplier: 2.0 }),
        makeWallet(),
      );
      instance.setLogger(spyLogger);
      await instance.getSigningClient();
      expect(spyLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('gasMultiplier 2 could not be applied'),
      );
    });

    it('setLogger is non-key: re-getInstance with the same config/wallet returns the SAME instance', () => {
      // setLogger is a pure field assignment, NOT part of the getInstance key — so calling it between
      // two same-key getInstance calls must NOT fragment the singleton (the load-bearing non-key proof).
      // SAME wallet reference both calls — a fresh makeWallet() would trip the reference-equality
      // wallet-invalidation gate (client.ts:182-185). Non-invalidation is INHERENT (setLogger only does
      // `this.logger = logger`); the cached-signing-client / disconnect path is deliberately NOT asserted
      // here because a single getSigningClient() in this MOCKED harness always hits the supersede-promise
      // disconnect and never caches `this.signingClient` (a pre-existing timing quirk, documented in the
      // getSigningClient describe block's omission note ~client.test.ts:444-446) — so a disconnect/caching
      // assertion would fail for reasons unrelated to setLogger.
      const w = makeWallet();
      const a = CosmosClientManager.getInstance(makeConfig(), w);
      a.setLogger(makeSpyLogger());
      const b = CosmosClientManager.getInstance(makeConfig(), w);
      expect(b).toBe(a);
    });

    it('is SILENT by default when setLogger is never called (the warn goes to the frozen noopLogger)', async () => {
      const mockSC = { disconnect: vi.fn() }; // no defaultGasMultiplier → triggers the warn branch
      mockConnectWithSigner.mockResolvedValue(mockSC as any);
      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      // No setLogger → this.logger is the real frozen noopLogger; the warn must be swallowed, no throw.
      await expect(instance.getSigningClient()).resolves.toBeDefined();
    });

    it('creates and returns signing client', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const client1 = await instance.getSigningClient();
      const client2 = await instance.getSigningClient();

      expect(client1).toBe(mockSC);
      expect(client2).toBe(mockSC);
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });

    it('deduplicates concurrent init calls', async () => {
      // Defer at the getSigner level so the signingClientPromise assignment
      // completes before the async body continues
      let resolveSigner!: (value: any) => void;
      const wallet = makeWallet({
        getSigner: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveSigner = resolve;
            }),
        ),
      });

      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);
      const p1 = instance.getSigningClient();
      const p2 = instance.getSigningClient();

      resolveSigner({});

      const [c1, c2] = await Promise.all([p1, p2]);
      expect(c1).toBe(c2);
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });

    // Note: The superseded-promise disconnect test is omitted because the
    // IIFE's thisInitPromise capture requires real async timing to work
    // correctly. This is covered by the e2e tests against a live chain.

    it('wraps non-ManifestMCPError into RPC_CONNECTION_FAILED', async () => {
      mockConnectWithSigner.mockRejectedValue(new Error('timeout'));

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await expect(instance.getSigningClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        message: expect.stringContaining('timeout'),
      });
    });
  });

  describe('disconnect', () => {
    it('disconnects signing client and allows re-initialization', async () => {
      mockCreateRPCQueryClient
        .mockResolvedValueOnce({ mock: 'qc1' } as any)
        .mockResolvedValueOnce({ mock: 'qc2' } as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await instance.getSigningClient();
      const qc1 = await instance.getQueryClient();
      expect(qc1).toMatchObject({ mock: 'qc1' });

      instance.disconnect();

      // Subsequent calls should re-initialize
      const qc2 = await instance.getQueryClient();
      expect(qc2).toMatchObject({ mock: 'qc2' });
    });
  });

  describe('ref-counted disconnect', () => {
    // We seed a cached signing client directly via the private-state cast
    // (the same pattern the rateLimiter tests use) instead of calling
    // getSigningClient(). In production the signing client is cached after
    // getSigningClient() and teardown calls its disconnect(); but in this
    // vitest harness getSigningClient()'s superseded-promise cleanup branch
    // runs under synchronous mock resolution — it invokes the mock's
    // disconnect() at init time and never caches the client — which would
    // confound a spy that is meant to measure ref-counted *teardown* timing.
    // Seeding isolates disconnect()'s ref-counting from that unrelated init
    // artifact (see the "omitted test" notes in getQueryClient/getSigningClient).
    const seedSigningClient = (
      instance: CosmosClientManager,
      client: unknown,
    ) => {
      (instance as unknown as { signingClient: unknown }).signingClient =
        client;
    };
    const readSigningClient = (instance: CosmosClientManager) =>
      (instance as unknown as { signingClient: unknown }).signingClient;

    it('only tears down the shared signing client after the last holder disconnects', () => {
      const mockSC = { disconnect: vi.fn() };

      const config = makeConfig();
      const wallet = makeWallet();
      // Two simulated servers acquire the same config key.
      const a = CosmosClientManager.getInstance(config, wallet);
      const b = CosmosClientManager.getInstance(config, wallet);
      expect(a).toBe(b);
      seedSigningClient(a, mockSC);

      // First holder releases — the shared client must stay live.
      a.disconnect();
      expect(mockSC.disconnect).not.toHaveBeenCalled();
      // Still the same live client (no teardown, no reconnect).
      expect(readSigningClient(b)).toBe(mockSC);

      // Last holder releases — now it tears down.
      b.disconnect();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
      expect(readSigningClient(b)).toBeNull();
    });

    it('single acquire still tears down on the first disconnect', () => {
      const mockSC = { disconnect: vi.fn() };

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      seedSigningClient(instance, mockSC);

      instance.disconnect();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
    });

    it('clearInstances force-tears-down even when refCount > 1', () => {
      const mockSC = { disconnect: vi.fn() };

      const config = makeConfig();
      const wallet = makeWallet();
      // Two holders → refCount is 2.
      const a = CosmosClientManager.getInstance(config, wallet);
      CosmosClientManager.getInstance(config, wallet);
      seedSigningClient(a, mockSC);

      // Force reset ignores the outstanding holders and tears down immediately.
      CosmosClientManager.clearInstances();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();

      // Registry was cleared, so a fresh getInstance yields a new instance.
      const fresh = CosmosClientManager.getInstance(config, wallet);
      expect(fresh).not.toBe(a);
    });

    it('over-disconnect is safe: extra disconnect() does not throw or re-tear-down', () => {
      const mockSC = { disconnect: vi.fn() };

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      seedSigningClient(instance, mockSC);

      instance.disconnect();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();

      // Extra disconnects beyond the acquisition count must be no-ops:
      // they neither throw nor tear down again (refCount stays at 0).
      expect(() => {
        instance.disconnect();
        instance.disconnect();
      }).not.toThrow();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
    });

    it('shared query client survives a non-last disconnect and re-inits only after the last (behavioral)', async () => {
      // Defense-in-depth: a purely behavioral check (no private-state access)
      // that exercises the query-client teardown path via re-initialization
      // count. The query client caches across getQueryClient() calls, so a
      // re-init signals teardown occurred.
      const config = makeConfig({ chainId: 'refcount-query-probe' });
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(config, wallet);
      const b = CosmosClientManager.getInstance(config, wallet);

      await a.getQueryClient();
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();

      // First holder releases — the shared query client must NOT be torn down.
      a.disconnect();
      await b.getQueryClient();
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();

      // Last holder releases — torn down, so the next query re-initializes.
      b.disconnect();
      await b.getQueryClient();
      expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearInstances', () => {
    it('removes all instances so new getInstance creates fresh ones', () => {
      const wallet = makeWallet();
      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);

      CosmosClientManager.clearInstances();

      // New getInstance should create a fresh instance
      const newInstance = CosmosClientManager.getInstance(makeConfig(), wallet);
      expect(newInstance).not.toBe(instance);
    });
  });

  describe('getAddress', () => {
    it('delegates to walletProvider', async () => {
      const wallet = makeWallet();
      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);
      const address = await instance.getAddress();
      expect(address).toBe('manifest1test');
      expect(wallet.getAddress).toHaveBeenCalledOnce();
    });
  });

  describe('getConfig', () => {
    it('returns the current config', () => {
      const config = makeConfig({ chainId: 'my-chain' });
      const instance = CosmosClientManager.getInstance(config, makeWallet());
      expect(instance.getConfig().chainId).toBe('my-chain');
    });
  });

  describe('LCD/REST query-only mode', () => {
    it('uses LCD client when restUrl is configured', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({
          restUrl: 'https://rest.example.com',
          rpcUrl: undefined,
          gasPrice: undefined,
        }),
        makeWallet(),
      );
      const client = await instance.getQueryClient();
      expect(mockCreateLCDQueryClient).toHaveBeenCalledWith(
        'https://rest.example.com',
        noopLogger,
      );
      expect(mockCreateRPCQueryClient).not.toHaveBeenCalled();
      expect(client).toEqual({ mock: 'lcdClient' });
    });

    it('prefers LCD when both restUrl and rpcUrl are configured', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({ restUrl: 'https://rest.example.com' }),
        makeWallet(),
      );
      await instance.getQueryClient();
      expect(mockCreateLCDQueryClient).toHaveBeenCalledWith(
        'https://rest.example.com',
        noopLogger,
      );
      expect(mockCreateRPCQueryClient).not.toHaveBeenCalled();
    });

    it('throws INVALID_CONFIG from getSigningClient when rpcUrl is not configured', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({
          restUrl: 'https://rest.example.com',
          rpcUrl: undefined,
          gasPrice: undefined,
        }),
        makeWallet(),
      );
      await expect(instance.getSigningClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: expect.stringContaining('query-only'),
      });
    });

    it('throws INVALID_CONFIG from getQueryClient when neither URL is configured', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({
          rpcUrl: undefined,
          gasPrice: undefined,
          restUrl: undefined,
        }),
        makeWallet(),
      );
      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: expect.stringContaining('neither restUrl nor rpcUrl'),
      });
    });
  });

  describe('rate limiting', () => {
    it('acquireRateLimit resolves immediately while tokens are available', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig({ rateLimit: { requestsPerSecond: 10 } }),
        makeWallet(),
      );
      const start = Date.now();
      // 5 acquisitions well below the 10/sec budget should not block.
      // We assert only that the budget did not force a refill wait
      // (which would be ~500 ms at 10 rps); a loose ceiling avoids
      // flakes on slow CI while still failing if throttling kicks in
      // when it shouldn't.
      await Promise.all([
        instance.acquireRateLimit(),
        instance.acquireRateLimit(),
        instance.acquireRateLimit(),
        instance.acquireRateLimit(),
        instance.acquireRateLimit(),
      ]);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(400);
    });

    it('acquireRateLimit throttles when budget is exhausted', async () => {
      // 2/sec budget; 4 acquisitions should take >= ~1s for the latter pair to
      // earn fresh tokens. Use a generous lower bound to avoid flakiness on
      // slow CI, but tight enough that an unlimited budget would fail it.
      const instance = CosmosClientManager.getInstance(
        makeConfig({
          chainId: 'rate-limit-test-2rps',
          rateLimit: { requestsPerSecond: 2 },
        }),
        makeWallet(),
      );
      const start = Date.now();
      await instance.acquireRateLimit();
      await instance.acquireRateLimit();
      await instance.acquireRateLimit();
      await instance.acquireRateLimit();
      const elapsed = Date.now() - start;
      // The 3rd and 4th acquisitions need to wait for refill; expect ~1s.
      expect(elapsed).toBeGreaterThanOrEqual(900);
    });

    it('replaces the rate limiter when requestsPerSecond changes', async () => {
      const config1 = makeConfig({
        chainId: 'rate-reconfig-test',
        rateLimit: { requestsPerSecond: 10 },
      });
      const config2 = {
        ...config1,
        rateLimit: { requestsPerSecond: 50 },
      };
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(config1, wallet);
      const before = (a as unknown as { rateLimiter: unknown }).rateLimiter;
      const b = CosmosClientManager.getInstance(config2, wallet);
      const after = (b as unknown as { rateLimiter: unknown }).rateLimiter;
      expect(a).toBe(b); // same singleton
      expect(after).not.toBe(before); // limiter object replaced
    });

    it('does not replace the rate limiter when requestsPerSecond is unchanged', async () => {
      const config = makeConfig({
        chainId: 'rate-stable-test',
        rateLimit: { requestsPerSecond: 7 },
      });
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(config, wallet);
      const before = (a as unknown as { rateLimiter: unknown }).rateLimiter;
      const b = CosmosClientManager.getInstance({ ...config }, wallet);
      const after = (b as unknown as { rateLimiter: unknown }).rateLimiter;
      expect(a).toBe(b);
      expect(after).toBe(before);
    });
  });

  describe('withBroadcastLock', () => {
    it('serializes same-address fns', async () => {
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-serialize' }),
        makeWallet(),
      );
      const order: string[] = [];
      const slow = () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            order.push('a-end');
            r();
          }, 30),
        );
      const fast = () => {
        order.push('b-run');
        return Promise.resolve();
      };
      const p1 = mgr.withBroadcastLock('addr1', async () => {
        order.push('a-start');
        await slow();
      });
      const p2 = mgr.withBroadcastLock('addr1', fast);
      await Promise.all([p1, p2]);
      expect(order).toEqual(['a-start', 'a-end', 'b-run']); // b waited for a
      mgr.disconnect();
    });

    it('runs different addresses concurrently', async () => {
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-concurrent' }),
        makeWallet(),
      );
      let bStarted = false;
      const p1 = mgr.withBroadcastLock(
        'addr1',
        () => new Promise<void>((r) => setTimeout(r, 30)),
      );
      const p2 = mgr.withBroadcastLock('addr2', async () => {
        bStarted = true;
      });
      await p2;
      expect(bStarted).toBe(true); // did not wait for addr1
      await p1;
      mgr.disconnect();
    });

    it('releases the lock on throw (next waiter still runs)', async () => {
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-release' }),
        makeWallet(),
      );
      await expect(
        mgr.withBroadcastLock('a', () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      await expect(
        mgr.withBroadcastLock('a', () => Promise.resolve('ok')),
      ).resolves.toBe('ok');
      mgr.disconnect();
    });
  });
});
