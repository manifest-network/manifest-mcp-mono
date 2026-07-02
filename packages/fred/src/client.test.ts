import { toBech32 } from '@cosmjs/encoding';
import type {
  LeaseUuid,
  ManifestClient,
  ManifestMCPConfig,
  ManifestQueryClient,
  WalletProvider,
} from '@manifest-network/manifest-mcp-core';
import {
  CosmosClientManager,
  LeaseState,
} from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import {
  createFredClient,
  type FredClient,
  shouldWarnUnguarded,
} from './client.js';

const FULL_CONFIG: ManifestMCPConfig = {
  chainId: 'test-1',
  rpcUrl: 'http://localhost:26657',
  gasPrice: '0.025umfx',
  restUrl: 'http://localhost:1317',
};
const ADDR = toBech32('manifest', new Uint8Array(20)); // checksum-valid
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000' as LeaseUuid;
const PROVIDER_URL = 'https://provider.example.com';

function fakeWallet(): WalletProvider {
  return {
    getAddress: async () => ADDR,
    getSigner: async () => ({}) as never,
    signArbitrary: async () => ({
      pub_key: { type: 'tendermint/PubKeySecp256k1', value: 'v' },
      signature: 's',
    }),
  };
}

function fakeManager(
  over: Partial<CosmosClientManager> = {},
): CosmosClientManager {
  return {
    getQueryClient: vi.fn(async () => makeMockQueryClient()),
    getSigningClient: vi.fn(),
    disconnect: vi.fn(),
    setLogger: vi.fn(),
    acquireRateLimit: vi.fn(async () => {}),
    getConfig: vi.fn(() => ({ chainId: 'test-1' })),
    getAddress: vi.fn(async () => ADDR), // subscribeLeaseStatus resolves the broadcast address per poll-setup
    ...over,
  } as unknown as CosmosClientManager;
}

afterEach(() => vi.restoreAllMocks());

describe('createFredClient', () => {
  it('createFredClient layers subscribeLeaseStatus over the core client', async () => {
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(fakeManager());
    const client = await createFredClient({
      config: FULL_CONFIG,
      walletProvider: fakeWallet(),
    });
    expect(typeof client.subscribeLeaseStatus).toBe('function');
    expect(typeof client.fundCredits).toBe('function'); // inherited from ManifestClient
    expect(typeof client.getLease).toBe('function');
    // The full provider lifecycle is bound onto the client (Task 5).
    expect(typeof client.browseCatalog).toBe('function');
    expect(typeof client.appStatus).toBe('function');
    expect(typeof client.getAppLogs).toBe('function');
    expect(typeof client.restartApp).toBe('function');
    expect(typeof client.updateApp).toBe('function');
    expect(typeof client.waitForAppReady).toBe('function');
    expect(typeof client.getLeaseConnectionInfo).toBe('function');
    expect(typeof client.deployApp).toBe('function');
    // providerAuth is attached at the composition root so the client satisfies FredAuthCtx.
    expect(typeof client.providerAuth.providerToken).toBe('function');
    expect(typeof client.providerAuth.leaseDataToken).toBe('function');
  });

  it('a bound provider method threads the client as ctx (browseCatalog reads via ctx.query)', async () => {
    // browseCatalog walks ctx.query.liftedinit.sku.v1; an empty mock query client yields empty lists.
    const query = makeMockQueryClient() as unknown as ManifestQueryClient;
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(
      fakeManager({ getQueryClient: vi.fn(async () => query) }),
    );
    const client = await createFredClient({
      config: FULL_CONFIG,
      walletProvider: fakeWallet(),
    });
    const result = await client.browseCatalog();
    expect(result).toEqual({ providers: [], skus: [] });
  });

  it('subscribeLeaseStatus forwards the client itself as ctx (a poll emits via onData)', async () => {
    // A query client that resolves the lease + provider, and a fetch returning a terminal status frame —
    // so the watch (over the client-as-ctx) emits onData + completes, proving forwarding.
    const query = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_PENDING,
          providerUuid: 'prov-1',
        },
      },
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: PROVIDER_URL } },
        },
      },
    }) as unknown as ManifestQueryClient;
    const statusFetch = vi.fn(async () => {
      const body = JSON.stringify({ state: 'LEASE_STATE_ACTIVE' }); // terminal-success
      return {
        ok: true,
        status: 200,
        text: async () => body,
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(
      fakeManager({ getQueryClient: vi.fn(async () => query) }),
    );

    const client = await createFredClient({
      config: FULL_CONFIG,
      walletProvider: fakeWallet(),
      fetch: statusFetch,
    });

    const onData = vi.fn();
    await new Promise<void>((resolve, reject) => {
      client.subscribeLeaseStatus(LEASE_UUID, {
        onData,
        onComplete: () => resolve(),
        onError: (e) => reject(e),
        intervalMs: 1,
        timeout: 5_000,
      });
    });
    expect(onData).toHaveBeenCalled();
    expect(statusFetch).toHaveBeenCalled(); // the watch used the client's injected fetch (ctx forwarded)
  });

  it('FredClient is ManifestClient & FredActions; a query-only client is not assignable', async () => {
    expectTypeOf<FredClient>().toMatchTypeOf<ManifestClient>();
    expectTypeOf<FredClient>().toHaveProperty('subscribeLeaseStatus');
    // A read client (no required signer) is NOT a FredClient.
    type ReadShape = Omit<ManifestClient, 'signer'>;
    expectTypeOf<ReadShape>().not.toMatchTypeOf<FredClient>();
  });
});

describe('shouldWarnUnguarded', () => {
  it('is true only on Node with no injected fetch', () => {
    expect(shouldWarnUnguarded(false, true)).toBe(true); // node, no fetch
    expect(shouldWarnUnguarded(true, true)).toBe(false); // node, fetch injected
    expect(shouldWarnUnguarded(false, false)).toBe(false); // browser, no fetch
    expect(shouldWarnUnguarded(true, false)).toBe(false); // browser, fetch injected
  });
});

describe('createFredClient unguarded-fetch warning', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('warns once (naming createFredClientNode) on Node with no injected fetch', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { createFredClient } = await import('./client.js');
    vi.spyOn(core.CosmosClientManager, 'getInstance').mockReturnValue(
      fakeManager(),
    );
    const warn = vi.spyOn(core.logger, 'warn').mockImplementation(() => {});

    await createFredClient({
      config: FULL_CONFIG,
      walletProvider: fakeWallet(),
    });
    await createFredClient({
      config: FULL_CONFIG,
      walletProvider: fakeWallet(),
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('createFredClientNode');
  });

  it('does not warn when a fetch is injected (even a plain globalThis.fetch)', async () => {
    const core = await import('@manifest-network/manifest-mcp-core');
    const { createFredClient } = await import('./client.js');
    vi.spyOn(core.CosmosClientManager, 'getInstance').mockReturnValue(
      fakeManager(),
    );
    const warn = vi.spyOn(core.logger, 'warn').mockImplementation(() => {});

    await createFredClient({
      config: FULL_CONFIG,
      walletProvider: fakeWallet(),
      fetch: globalThis.fetch,
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
