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
      // Pin the pair: a live client is NOT disconnected at init (pre-ENG-636 the always-taken
      // supersede branch disconnected it here), and IS disconnected when eviction evicts it.
      expect(client1.disconnect).not.toHaveBeenCalled();

      // Re-get with different gasPrice — should create new signing client
      CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '2.0umfx' }),
        wallet,
      );
      const sc2 = await instance.getSigningClient();
      expect(sc2).toBe(client2);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
      // The invalidation path disconnects the client it evicts. Dead code before ENG-636
      // (`signingClient` was never populated, so the guard never fired).
      expect(client1.disconnect).toHaveBeenCalledOnce();
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

    it('does not latch a rejected init — a transient failure recovers on the next call (ENG-636)', async () => {
      mockCreateRPCQueryClient
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ mock: 'qc-recovered' } as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );

      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      });
      // Before ENG-636 the rejected promise stayed in queryClientPromise and every later
      // caller re-awaited it: one transient RPC blip was a permanent outage until restart.
      await expect(instance.getQueryClient()).resolves.toMatchObject({
        mock: 'qc-recovered',
      });
      expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2);
    });

    it('does not latch a rejected LCD init either (ENG-636)', async () => {
      mockCreateLCDQueryClient
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ mock: 'lcd-recovered' } as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ rpcUrl: undefined, restUrl: 'https://lcd.example.com' }),
        makeWallet(),
      );

      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        message: expect.stringContaining('REST'),
      });
      await expect(instance.getQueryClient()).resolves.toEqual({
        mock: 'lcd-recovered',
      });
      expect(mockCreateLCDQueryClient).toHaveBeenCalledTimes(2);
    });

    it('promotes the resolved client to the object cache and releases the slot (ENG-636)', async () => {
      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const client = await instance.getQueryClient();

      // From the outside a latched resolved promise and a real object cache are
      // indistinguishable, so probe the private slots directly (the same private-state cast
      // the rateLimiter tests use). Before ENG-636 `queryClient` was never populated and the
      // promise slot was never released — the documented caching layer was dead code.
      const priv = instance as unknown as {
        queryClient: unknown;
        queryClientPromise: unknown;
      };
      expect(priv.queryClient).toBe(client);
      expect(priv.queryClientPromise).toBeNull();
    });

    it('supersedes an in-flight init when teardown lands mid-flight (ENG-636)', async () => {
      let resolveInit!: (value: any) => void;
      mockCreateRPCQueryClient.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInit = resolve;
          }) as any,
      );

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const p1 = instance.getQueryClient(); // init #1 owns the slot
      instance.disconnect(); // refCount 1 -> 0 -> teardown() nulls the slot

      resolveInit({ mock: 'qc1' });
      // The caller that asked for it is still served: a query client is stateless HTTP with
      // nothing to release, so being superseded only means "not cached".
      await expect(p1).resolves.toMatchObject({ mock: 'qc1' });

      mockCreateRPCQueryClient.mockResolvedValueOnce({ mock: 'qc2' } as any);
      await expect(instance.getQueryClient()).resolves.toMatchObject({
        mock: 'qc2',
      });
      expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2);
    });

    it('identity guard is load-bearing: a stale init must not clobber a newer one (ENG-636)', async () => {
      let resolve1!: (value: any) => void;
      let resolve2!: (value: any) => void;
      mockCreateRPCQueryClient
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolve1 = resolve;
            }) as any,
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolve2 = resolve;
            }) as any,
        );

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const p1 = instance.getQueryClient(); // init #1 owns the slot
      instance.disconnect(); // teardown nulls the slot
      const p2 = instance.getQueryClient(); // init #2 owns the slot

      // Settle the NEWER init first, then the stale one. That order is what makes this test
      // discriminating: if #1 settled first, #2's own handler would repair the damage and the
      // test would still pass with the guard deleted.
      resolve2({ mock: 'qc2' });
      await expect(p2).resolves.toMatchObject({ mock: 'qc2' });
      resolve1({ mock: 'qc1' });
      await expect(p1).resolves.toMatchObject({ mock: 'qc1' });

      // With the guard, #1's stale handler sees `slot !== p` and changes nothing. Without it,
      // the cache now holds qc1 and this assertion fails.
      await expect(instance.getQueryClient()).resolves.toMatchObject({
        mock: 'qc2',
      });
      expect(mockCreateRPCQueryClient).toHaveBeenCalledTimes(2);
    });
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

    it('setLogger is non-key and non-invalidating: same instance AND same cached signing client', async () => {
      // setLogger is a pure field assignment, NOT part of the getInstance key and NOT in the
      // invalidation gate — so calling it between two same-key getInstance calls must neither
      // fragment the singleton nor drop the cached signing client. SAME wallet reference both
      // calls: a fresh makeWallet() would trip the reference-equality wallet-invalidation gate
      // (client.ts getInstance). The caching half of this proof used to be unassertable because
      // getSigningClient() never populated `this.signingClient` (ENG-636); it is asserted now.
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const w = makeWallet();
      const a = CosmosClientManager.getInstance(makeConfig(), w);
      const sc1 = await a.getSigningClient();
      a.setLogger(makeSpyLogger());
      const b = CosmosClientManager.getInstance(makeConfig(), w);

      expect(b).toBe(a);
      expect(await b.getSigningClient()).toBe(sc1);
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
      expect(mockSC.disconnect).not.toHaveBeenCalled();
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
      // Defer at the getSigner level to keep init #1 in flight while both calls are made.
      // (Post-ENG-636 the slot assignment is unconditionally synchronous inside the accessor,
      // so the deferral is no longer needed to win a race against it — it just holds the
      // window open long enough for the second call to observe the in-flight promise.)
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

    it('does not latch a rejected init — a transient failure recovers on the next call (ENG-636)', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );

      await expect(instance.getSigningClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      });
      await expect(instance.getSigningClient()).resolves.toBe(mockSC);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('a successful init does NOT disconnect the client it returns, and caches it (ENG-636)', async () => {
      // Two assertions that cannot both hold on the pre-fix code: the supersede `else` branch
      // fired on EVERY successful init, disconnecting the client it was about to return, and
      // `this.signingClient` was never populated so teardown had nothing to disconnect. The
      // spurious init-time disconnect was inert only by accident — @cosmjs/tendermint-rpc's
      // HttpClient.disconnect() is a no-op — so a WebSocket endpoint would have been closed
      // the instant it was created.
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      const client = await instance.getSigningClient();

      expect(client).toBe(mockSC);
      expect(mockSC.disconnect).not.toHaveBeenCalled();

      instance.disconnect(); // refCount 1 -> 0 -> teardown()
      // Only reachable if `this.signingClient` was actually populated.
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
    });

    it('supersede: teardown mid-init releases the orphan and fails the caller (ENG-636)', async () => {
      let resolveSigner!: (value: any) => void;
      const wallet = makeWallet({
        getSigner: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveSigner = resolve;
            }),
        ),
      });
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);
      const p1 = instance.getSigningClient(); // init in flight
      instance.disconnect(); // refCount 1 -> 0 -> teardown() nulls the slot

      resolveSigner({});

      // Unlike the query client this one owns a live transport, so the orphan must be released
      // and must NOT be handed back — the caller is told to retry for the current config.
      await expect(p1).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        details: { reason: 'superseded' },
      });
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });

    it('supersede: a getInstance config change mid-init releases the orphan; the retry gets a fresh client (ENG-636)', async () => {
      let resolveSigner!: (value: any) => void;
      const wallet = makeWallet({
        // Defer only the FIRST getSigner so the retry below can complete.
        getSigner: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                resolveSigner = resolve;
              }),
          )
          .mockResolvedValue({}),
      });
      const client1 = { disconnect: vi.fn() };
      const client2 = { disconnect: vi.fn() };
      mockConnectWithSigner
        .mockResolvedValueOnce(client1 as any)
        .mockResolvedValueOnce(client2 as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '1.0umfx' }),
        wallet,
      );
      const p1 = instance.getSigningClient(); // init in flight on the OLD gasPrice
      // Nulls signingClientPromise (the signingClient slot is still null mid-flight).
      CosmosClientManager.getInstance(
        makeConfig({ gasPrice: '2.0umfx' }),
        wallet,
      );

      resolveSigner({});

      await expect(p1).rejects.toMatchObject({
        details: { reason: 'superseded' },
      });
      expect(client1.disconnect).toHaveBeenCalledOnce();

      // The retry the error tells the caller to make yields a freshly-built client.
      await expect(instance.getSigningClient()).resolves.toBe(client2);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

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
    // These tests drive the REAL getSigningClient() path. They used to seed `signingClient`
    // through a private-state cast, because the pre-ENG-636 init never cached the client and
    // disconnected it at init time — an artifact that would have confounded a spy measuring
    // ref-counted teardown. Now that the cache works, seeding would only hide a regression:
    // if caching broke again, these would still pass. `readSigningClient` stays as a read-only
    // probe of the slot teardown is supposed to null.
    const readSigningClient = (instance: CosmosClientManager) =>
      (instance as unknown as { signingClient: unknown }).signingClient;

    it('only tears down the shared signing client after the last holder disconnects', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const config = makeConfig();
      const wallet = makeWallet();
      // Two simulated servers acquire the same config key.
      const a = CosmosClientManager.getInstance(config, wallet);
      const b = CosmosClientManager.getInstance(config, wallet);
      expect(a).toBe(b);
      expect(await a.getSigningClient()).toBe(mockSC);

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

    it('single acquire still tears down on the first disconnect', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await instance.getSigningClient();

      instance.disconnect();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();
    });

    it('clearInstances force-tears-down even when refCount > 1', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const config = makeConfig();
      const wallet = makeWallet();
      // Two holders → refCount is 2.
      const a = CosmosClientManager.getInstance(config, wallet);
      CosmosClientManager.getInstance(config, wallet);
      await a.getSigningClient();

      // Force reset ignores the outstanding holders and tears down immediately.
      CosmosClientManager.clearInstances();
      expect(mockSC.disconnect).toHaveBeenCalledOnce();

      // Registry was cleared, so a fresh getInstance yields a new instance.
      const fresh = CosmosClientManager.getInstance(config, wallet);
      expect(fresh).not.toBe(a);
    });

    it('over-disconnect is safe: extra disconnect() does not throw or re-tear-down', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(
        makeConfig(),
        makeWallet(),
      );
      await instance.getSigningClient();

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

    // ENG-710. Real timers throughout, matching the two timing tests above: `limiter` derives its
    // clock from `performance.now()` and the poll loop uses the global `setTimeout`, so a partial
    // `vi.useFakeTimers({ toFake: [...] })` would freeze one and not the other — and a poll loop
    // under `vi.runAllTimersAsync()` spins until sinon's timer cap. Give each test its own chainId:
    // getInstance is a keyed singleton.
    describe('cancellable acquisition', () => {
      it('rejects an already-aborted acquisition with the raw reason, spending no token', async () => {
        const instance = CosmosClientManager.getInstance(
          makeConfig({
            chainId: 'rl-cancel-pre',
            rateLimit: { requestsPerSecond: 1 },
          }),
          makeWallet(),
        );
        const ac = new AbortController();
        ac.abort('user cancelled'); // the MCP wire shape: a bare string
        await expect(instance.acquireRateLimit(ac.signal)).rejects.toBe(
          'user cancelled',
        );
        // Budget intact. This is the assertion that catches the likeliest implementation bug —
        // a poll loop whose first `tryRemoveTokens` runs before it ever looks at the signal
        // would still reject, but would have eaten the only token first.
        const t0 = Date.now();
        await instance.acquireRateLimit();
        expect(Date.now() - t0).toBeLessThan(100);
      });

      it('an abort DURING the wait rejects at once and consumes no token', async () => {
        const instance = CosmosClientManager.getInstance(
          makeConfig({
            chainId: 'rl-cancel-mid',
            rateLimit: { requestsPerSecond: 1 },
          }),
          makeWallet(),
        );
        await instance.acquireRateLimit(); // drain the single token
        const ac = new AbortController();
        const t0 = Date.now();
        const parked = instance.acquireRateLimit(ac.signal);
        setTimeout(() => ac.abort('cancelled mid-wait'), 50);
        await expect(parked).rejects.toBe('cancelled mid-wait');
        // (i) it surfaced promptly rather than at the ~1000ms token grant
        expect(Date.now() - t0).toBeLessThan(400);
        // (ii) and the token it did not take is still there for the next interval. A design that
        // merely RACES `removeTokens` also rejects promptly but leaves the abandoned wait to
        // consume the token, pushing this acquire out to ~2000ms.
        await instance.acquireRateLimit();
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(1800);
      });

      it('resolves normally when a token is available and the signal stays live', async () => {
        const instance = CosmosClientManager.getInstance(
          makeConfig({
            chainId: 'rl-cancel-happy',
            rateLimit: { requestsPerSecond: 10 },
          }),
          makeWallet(),
        );
        const ac = new AbortController();
        const t0 = Date.now();
        await instance.acquireRateLimit(ac.signal);
        expect(Date.now() - t0).toBeLessThan(100); // no poll tick on the uncontended path
      });

      // A bucket that cannot hold one token is the one input where polling and `removeTokens`
      // disagree: `tryRemoveTokens` declines forever where `removeTokens` throws. Unguarded, the
      // poll turns a loud failure into a silent hang — so this is a hang-detector as much as an
      // assertion. Reachable because `getInstance` takes an UNVALIDATED config and is on the
      // public SDK barrel, while `validateConfig` would have rejected this rps.
      it.each([
        ['with a signal', true],
        ['without a signal', false],
      ])(
        'rejects INVALID_CONFIG instead of hanging when requestsPerSecond < 1 (%s)',
        async (_label, withSignal) => {
          const instance = CosmosClientManager.getInstance(
            makeConfig({
              chainId: `rl-sub-one-${withSignal}`,
              rateLimit: { requestsPerSecond: 0.5 },
            }),
            makeWallet(),
          );
          const signal = withSignal ? new AbortController().signal : undefined;
          await expect(instance.acquireRateLimit(signal)).rejects.toMatchObject(
            {
              code: ManifestMCPErrorCode.INVALID_CONFIG,
            },
          );
        },
      );
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

    it('releases broadcast-lock entries as their chains drain (bounded map growth)', async () => {
      // Code-review PR #102 + Copilot: withBroadcastLock must release a
      // per-address entry once its queued chain drains, so a long-lived manager
      // broadcasting from many distinct addresses does not grow the map without
      // bound (the common single-signer case sits at size 0 between broadcasts).
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-bounded' }),
        makeWallet(),
      );
      const locks = (mgr as unknown as { broadcastLocks: Map<string, unknown> })
        .broadcastLocks;
      await mgr.withBroadcastLock('addr1', () => Promise.resolve());
      await mgr.withBroadcastLock('addr2', () => Promise.resolve());
      // delete-on-settle runs a microtask after each tail settles — flush them.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(locks.size).toBe(0); // drained entries released, not retained
      mgr.disconnect();
    });

    it('teardown clears an in-flight broadcast-lock entry', async () => {
      // Belt-and-suspenders for the delete-on-settle above: a broadcast still
      // in flight at disconnect time has a live map entry; teardown() clears it
      // immediately so a reused config key starts clean (code-review PR #102).
      const mgr = CosmosClientManager.getInstance(
        makeConfig({ chainId: 'lock-teardown' }),
        makeWallet(),
      );
      const locks = (mgr as unknown as { broadcastLocks: Map<string, unknown> })
        .broadcastLocks;
      let release!: () => void;
      const pending = new Promise<void>((r) => {
        release = r;
      });
      const inflight = mgr.withBroadcastLock('addr1', () => pending);
      expect(locks.size).toBe(1); // entry present while the broadcast is in flight
      mgr.disconnect(); // refCount 0 → teardown clears the map immediately
      expect(locks.size).toBe(0);
      release();
      await inflight;
    });
  });
});
