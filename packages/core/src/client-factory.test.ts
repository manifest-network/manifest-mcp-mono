import { toBech32 } from '@cosmjs/encoding';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CosmosClientManager, type ManifestQueryClient } from './client.js';
import { createManifestReadClient } from './client-factory.js';
import { createManifestClient } from './client-full.js';
import { noopLogger } from './logger.js';
import { type ManifestMCPConfig, ManifestMCPErrorCode } from './types.js';

// REST-mode config; getInstance is mocked so no real client/network is built.
const READ_CONFIG: ManifestMCPConfig = {
  chainId: 'test-1',
  restUrl: 'http://localhost:1317',
};
const FULL_CONFIG: ManifestMCPConfig = {
  chainId: 'test-1',
  rpcUrl: 'http://localhost:26657',
  gasPrice: '0.025umfx',
  restUrl: 'http://localhost:1317',
};
const ADDR = toBech32('manifest', new Uint8Array(20)); // checksum-valid (mirrors signer.test.ts)
const SENTINEL_QUERY = {
  __sentinel: 'query',
} as unknown as ManifestQueryClient;

function fakeManager(
  over: Partial<CosmosClientManager> = {},
): CosmosClientManager {
  return {
    getQueryClient: vi.fn(async () => SENTINEL_QUERY),
    getSigningClient: vi.fn(),
    disconnect: vi.fn(),
    setLogger: vi.fn(),
    ...over,
  } as unknown as CosmosClientManager;
}
function fakeWallet() {
  return {
    getAddress: async () => ADDR,
    getSigner: async () => ({}) as never,
    signArbitrary: async () => ({
      pub_key: { type: 't', value: 'v' },
      signature: 's',
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('createManifestReadClient / createManifestClient', () => {
  it('validates config BEFORE keying an instance (invalid → INVALID_CONFIG, getInstance not called)', async () => {
    const spy = vi.spyOn(CosmosClientManager, 'getInstance');
    await expect(
      createManifestReadClient({
        config: { chainId: 'test-1' } as ManifestMCPConfig,
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls getInstance exactly once and feeds ctx.query from the awaited getQueryClient', async () => {
    const mgr = fakeManager();
    const spy = vi
      .spyOn(CosmosClientManager, 'getInstance')
      .mockReturnValue(mgr);
    const client = await createManifestReadClient({ config: READ_CONFIG });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mgr.getQueryClient).toHaveBeenCalledTimes(1);
    expect(client.query).toBe(SENTINEL_QUERY);
  });

  it('full mode passes the REAL walletProvider to getInstance and wires a prefix-pinned signer', async () => {
    const wallet = fakeWallet();
    const spy = vi
      .spyOn(CosmosClientManager, 'getInstance')
      .mockReturnValue(fakeManager());
    const full = await createManifestClient({
      config: FULL_CONFIG,
      walletProvider: wallet,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(wallet);
    expect(full.signer).toBeDefined();
    await expect(full.signer.getAddress()).resolves.toBe(ADDR); // signer REQUIRED on ManifestClient; adapter parses+brands
  });

  it('query-only mode passes a stub that REJECTS INVALID_CONFIG on signing access, and omits signer at runtime', async () => {
    let captured: { getSigner: () => Promise<unknown> } | undefined;
    vi.spyOn(CosmosClientManager, 'getInstance').mockImplementation(
      (_cfg, wallet) => {
        captured = wallet as never;
        return fakeManager();
      },
    );
    const read = await createManifestReadClient({ config: READ_CONFIG });
    expect('signer' in read).toBe(false); // truly omitted, not present-as-undefined
    expect(captured).toBeDefined();
    await expect(captured!.getSigner()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
  });

  it('coalesces fetch and logger to defaults, and uses injected ones when provided', async () => {
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(fakeManager());
    const dflt = await createManifestReadClient({ config: READ_CONFIG });
    expect(dflt.fetch).toBe(globalThis.fetch);
    expect(dflt.logger).toBe(noopLogger);

    const myFetch = (async () => new Response()) as typeof globalThis.fetch;
    const myLogger = { debug() {}, info() {}, warn() {}, error() {} };
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(fakeManager());
    const injected = await createManifestReadClient({
      config: READ_CONFIG,
      fetch: myFetch,
      logger: myLogger,
    });
    expect(injected.fetch).toBe(myFetch);
    expect(injected.logger).toBe(myLogger);
  });

  it('injects the resolved logger into the manager via setLogger', async () => {
    const mgr = fakeManager();
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    const myLogger = { debug() {}, info() {}, warn() {}, error() {} };
    await createManifestReadClient({ config: READ_CONFIG, logger: myLogger });
    expect(mgr.setLogger).toHaveBeenCalledWith(myLogger);
  });

  it('injects noopLogger by default', async () => {
    const mgr = fakeManager();
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    await createManifestReadClient({ config: READ_CONFIG });
    expect(mgr.setLogger).toHaveBeenCalledWith(noopLogger);
  });

  it('dispose() calls chain.disconnect() exactly once (idempotent)', async () => {
    const mgr = fakeManager();
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    const client = await createManifestReadClient({ config: READ_CONFIG });
    client.dispose();
    client.dispose();
    expect(mgr.disconnect).toHaveBeenCalledTimes(1);
  });

  it('releases the refCount once if getQueryClient REJECTS during construction (no phantom holder)', async () => {
    const mgr = fakeManager({
      getQueryClient: vi.fn(async () => {
        throw new Error('RPC_CONNECTION_FAILED');
      }),
    });
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    await expect(
      createManifestReadClient({ config: READ_CONFIG }),
    ).rejects.toThrow('RPC_CONNECTION_FAILED');
    expect(mgr.disconnect).toHaveBeenCalledTimes(1); // construction-failure release balances the acquire
  });

  it('full mode: releases the refCount once if getQueryClient rejects during construction', async () => {
    const mgr = fakeManager({
      getQueryClient: vi.fn(async () => {
        throw new Error('RPC_CONNECTION_FAILED');
      }),
    });
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    await expect(
      createManifestClient({
        config: FULL_CONFIG,
        walletProvider: fakeWallet(),
      }),
    ).rejects.toThrow('RPC_CONNECTION_FAILED');
    // signer is constructed BEFORE the await; the construction-failure release must still disconnect once.
    expect(mgr.disconnect).toHaveBeenCalledTimes(1);
  });

  it('full mode: dispose() calls chain.disconnect() exactly once (idempotent)', async () => {
    const mgr = fakeManager();
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);
    const full = await createManifestClient({
      config: FULL_CONFIG,
      walletProvider: fakeWallet(),
    });
    full.dispose();
    full.dispose();
    expect(mgr.disconnect).toHaveBeenCalledTimes(1);
  });

  it('read client exposes bound read methods that forward ctx (client) to the free fn', async () => {
    // A query client that records the lease() arg + lets getLease's read path resolve.
    const lease = vi.fn(async () => ({ lease: null }));
    const queryClient = {
      liftedinit: { billing: { v1: { lease } } },
    } as unknown as ManifestQueryClient;
    const mgr = fakeManager({
      getQueryClient: vi.fn(async () => queryClient),
      acquireRateLimit: vi.fn(async () => {}),
    });
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(mgr);

    const client = await createManifestReadClient({ config: READ_CONFIG });
    // All 10 bound reads exist as functions.
    for (const name of [
      'getBalance',
      'resolveSku',
      'listSkuCandidates',
      'getLeasesByTenant',
      'getLease',
      'getLeaseByCustomDomain',
      'getSKUs',
      'getProviders',
      'getBillingParams',
      'getWithdrawableAmount',
    ] as const) {
      expect(typeof client[name]).toBe('function');
    }
    // forwarding: a bound read drops ctx and forwards the rest to the free fn, which reads ctx.query.
    await expect(client.getLease('lease-uuid')).resolves.toBeNull();
    expect(lease).toHaveBeenCalledWith({ leaseUuid: 'lease-uuid' });
  });

  it('full client has tx methods; read client does not (runtime)', async () => {
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(fakeManager());
    const full = await createManifestClient({
      config: FULL_CONFIG,
      walletProvider: fakeWallet(),
    });
    vi.spyOn(CosmosClientManager, 'getInstance').mockReturnValue(fakeManager());
    const read = await createManifestReadClient({ config: READ_CONFIG });
    expect(typeof full.fundCredits).toBe('function');
    expect(typeof full.setItemCustomDomain).toBe('function');
    expect(typeof full.stopApp).toBe('function');
    expect(typeof full.executeTx).toBe('function');
    expect('fundCredits' in read).toBe(false);
    expect('executeTx' in read).toBe(false);
    expect('signer' in read).toBe(false); // query-only omits the signer key (4b invariant)
  });
});
