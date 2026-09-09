import { toBech32 } from '@cosmjs/encoding';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmosClientManager } from './client.js';
import { createManifestReadClient } from './client-factory.js';
import { createManifestClient } from './client-full.js';
import { ManifestMCPErrorCode, type WalletProvider } from './types.js';

// Only the query transport and connected signing transport are replaced. Factories, manager,
// signer adapters, gas policy, locks, and sequence handling all run as shipped.
vi.mock('./lcd-adapter.js', () => ({
  createLCDQueryClient: vi.fn(async () => ({})),
}));

const CHAIN_ID = 'identity-test';
const CONFIG = {
  chainId: CHAIN_ID,
  rpcUrl: 'https://rpc.example.com',
  restUrl: 'https://rest.example.com/prefix/',
  gasPrice: '0.025umfx',
  maxGas: 100,
  retry: { maxRetries: 0 },
};
const MESSAGE = { typeUrl: '/review.Msg', value: {} };
const FEE = { amount: [], gas: '100' };
const ADDRESS_A = toBech32('manifest', new Uint8Array(20).fill(1));
const ADDRESS_B = toBech32('manifest', new Uint8Array(20).fill(2));

function wallet(address: string): WalletProvider {
  const signer: OfflineSigner = {
    getAccounts: async () => [],
    signDirect: vi.fn(),
  };
  return { getAddress: async () => address, getSigner: async () => signer };
}

function transport(chainId = CHAIN_ID) {
  return {
    getChainId: vi.fn(async () => chainId),
    disconnect: vi.fn(),
    defaultGasMultiplier: 1.4,
    getSequence: vi.fn(async (_address: string) => ({
      accountNumber: 1,
      sequence: 7,
    })),
    signAndBroadcast: vi.fn(async (_sender: string) => ({
      code: 0,
      transactionHash: 'hash',
      height: 1,
      gasUsed: 1n,
      gasWanted: 1n,
      events: [],
      msgResponses: [],
    })),
    async signAndBroadcastSync(sender: string) {
      const { sequence } = await this.getSequence(sender);
      return `hash-${sequence}`;
    },
  };
}

function chainFetch(chainId = CHAIN_ID) {
  return vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      default_node_info: { network: chainId },
    }),
  );
}

beforeEach(() => CosmosClientManager.clearInstances());
afterEach(() => {
  CosmosClientManager.clearInstances();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('public client ownership', () => {
  it('preserves each wallet and gas ceiling when another full/read client shares endpoints', async () => {
    const wire = transport();
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
      wire as unknown as SigningStargateClient,
    );
    const fetch = chainFetch();
    const a = await createManifestClient({
      config: CONFIG,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: fetch,
    });
    const b = await createManifestClient({
      config: { ...CONFIG, maxGas: 500 },
      walletProvider: wallet(ADDRESS_B),
      chainIdentityFetch: fetch,
    });
    const read = await createManifestReadClient({
      config: CONFIG,
      chainIdentityFetch: fetch,
    });

    await expect(
      a.executeTx([MESSAGE], { fee: { amount: [], gas: '200' } }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED });
    await b.executeTx([MESSAGE], { fee: { amount: [], gas: '200' } });
    await a.executeTx([MESSAGE], { fee: FEE });
    expect(wire.signAndBroadcast.mock.calls.map(([sender]) => sender)).toEqual([
      ADDRESS_B,
      ADDRESS_A,
    ]);
    await expect(a.signer.getAddress()).resolves.toBe(ADDRESS_A);
    await expect(b.signer.getAddress()).resolves.toBe(ADDRESS_B);
    await expect(read.chain.getSigningClient()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
    read.dispose();
    b.dispose();
    await a.executeTx([MESSAGE], { fee: FEE });
    a.dispose();
  });

  it('snapshots nested policy and rejects mutation through getConfig during an approved operation', async () => {
    const wire = transport();
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
      wire as unknown as SigningStargateClient,
    );
    const config = {
      ...CONFIG,
      retry: { maxRetries: 0 },
      rateLimit: { requestsPerSecond: 5 },
    };
    const a = await createManifestClient({
      config,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: chainFetch(),
    });
    config.maxGas = 500;
    config.retry.maxRetries = 99;
    config.rateLimit.requestsPerSecond = 999;
    expect(a.chain.getConfig()).toMatchObject({
      maxGas: 100,
      retry: { maxRetries: 0 },
      rateLimit: { requestsPerSecond: 5 },
    });
    expect(Reflect.set(a.chain.getConfig(), 'maxGas', 500)).toBe(false);
    expect(Reflect.set(a.chain.getConfig().retry!, 'maxRetries', 99)).toBe(
      false,
    );
    await expect(
      a.executeTx([MESSAGE], { fee: { amount: [], gas: '200' } }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED });
    expect(wire.signAndBroadcast).not.toHaveBeenCalled();
    a.dispose();
  });

  it('shares locks and pending sequences across wallet adapters, policies, and RPC endpoints', async () => {
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockImplementation(
      async () => transport() as unknown as SigningStargateClient,
    );
    const fetch = chainFetch();
    const a = await createManifestClient({
      config: CONFIG,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: fetch,
    });
    const b = await createManifestClient({
      config: { ...CONFIG, maxGas: 500, rpcUrl: 'https://rpc2.example.com' },
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: fetch,
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = a.chain.withBroadcastLock(ADDRESS_A, () => pending);
    let sent = false;
    const queued = b
      .executeTx([MESSAGE], { fee: FEE, waitForConfirmation: false })
      .then((result) => {
        sent = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toBe(false);
    release();
    await locked;
    const first = await queued;
    const second = await a.executeTx([MESSAGE], {
      fee: FEE,
      waitForConfirmation: false,
    });
    expect(first.transactionHash).toBe('hash-7');
    expect(second.transactionHash).toBe('hash-8');
    a.dispose();
    const third = await b.executeTx([MESSAGE], {
      fee: FEE,
      waitForConfirmation: false,
    });
    expect(third.transactionHash).toBe('hash-9');
    await expect(a.executeTx([MESSAGE], { fee: FEE })).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
    b.dispose();
  });

  it('keeps compatible sibling connections live until the final holder disposes', async () => {
    const wire = transport();
    const connect = vi
      .spyOn(SigningStargateClient, 'connectWithSigner')
      .mockResolvedValue(wire as unknown as SigningStargateClient);
    const opts = {
      config: CONFIG,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: chainFetch(),
    };
    const a = await createManifestClient(opts);
    const b = await createManifestClient({ ...opts, config: { ...CONFIG } });
    expect(a.chain).toBe(b.chain);
    await a.executeTx([MESSAGE], { fee: FEE });
    a.dispose();
    expect(wire.disconnect).not.toHaveBeenCalled();
    await b.executeTx([MESSAGE], { fee: FEE });
    expect(connect).toHaveBeenCalledOnce();
    b.dispose();
    expect(wire.disconnect).toHaveBeenCalledOnce();
  });
});

describe('endpoint chain identity', () => {
  it('uses the captured platform transport for a trusted local chain independently of provider fetch', async () => {
    const identityFetch = chainFetch();
    const providerFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('Provider transport must not receive chain requests');
    });
    vi.stubGlobal('fetch', identityFetch);
    const client = await createManifestReadClient({
      config: { ...CONFIG, restUrl: 'http://127.0.0.1:1317/local' },
      fetch: providerFetch,
    });
    expect(identityFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1317/local/cosmos/base/tendermint/v1beta1/node_info',
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(client.fetch).toBe(providerFetch);
    expect(providerFetch).not.toHaveBeenCalled();
    client.dispose();
  });

  it('keeps identity injection independent from provider fetch and fails closed on its mismatch', async () => {
    const providerFetch = chainFetch();
    const identityFetch = chainFetch('wrong-chain');
    const platformFetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', platformFetch);
    await expect(
      createManifestReadClient({
        config: CONFIG,
        fetch: providerFetch,
        chainIdentityFetch: identityFetch,
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    expect(identityFetch).toHaveBeenCalledOnce();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it('rejects an RPC mismatch before any broadcast and disconnects the rejected transport', async () => {
    const wire = transport('wrong-chain');
    const connect = vi
      .spyOn(SigningStargateClient, 'connectWithSigner')
      .mockResolvedValue(wire as unknown as SigningStargateClient);
    const client = await createManifestClient({
      config: CONFIG,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: chainFetch(),
    });
    await expect(
      client.executeTx([MESSAGE], { fee: FEE }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      details: { expectedChainId: CHAIN_ID, actualChainId: 'wrong-chain' },
    });
    expect(wire.signAndBroadcast).not.toHaveBeenCalled();
    expect(wire.disconnect).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    client.dispose();
  });

  it('checks each replacement connection and recovers from an identity-read failure', async () => {
    const unavailable = transport();
    unavailable.getChainId.mockRejectedValue(new Error('identity unavailable'));
    const valid = transport();
    const mismatched = transport('different-chain');
    vi.spyOn(SigningStargateClient, 'connectWithSigner')
      .mockResolvedValueOnce(unavailable as unknown as SigningStargateClient)
      .mockResolvedValueOnce(valid as unknown as SigningStargateClient)
      .mockResolvedValueOnce(mismatched as unknown as SigningStargateClient);
    const opts = {
      config: CONFIG,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: chainFetch(),
    };
    const a = await createManifestClient(opts);
    await expect(a.chain.getSigningClient()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    });
    expect(unavailable.disconnect).toHaveBeenCalledOnce();
    await expect(a.chain.getSigningClient()).resolves.toBe(valid);
    a.dispose();
    const replacement = await createManifestClient(opts);
    await expect(replacement.chain.getSigningClient()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
    expect(mismatched.disconnect).toHaveBeenCalledOnce();
    replacement.dispose();
  });

  it('rejects REST/RPC disagreement through both full and read factories', async () => {
    const connect = vi.spyOn(SigningStargateClient, 'connectWithSigner');
    const fetch = chainFetch('wrong-rest-chain');
    await expect(
      createManifestClient({
        config: CONFIG,
        walletProvider: wallet(ADDRESS_A),
        chainIdentityFetch: fetch,
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    await expect(
      createManifestReadClient({ config: CONFIG, chainIdentityFetch: fetch }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    expect(connect).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      'https://rest.example.com/prefix/cosmos/base/tendermint/v1beta1/node_info',
      expect.objectContaining({
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    [
      'unavailable',
      () => new Response(null, { status: 503 }),
      ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    ],
    [
      'malformed',
      () => Response.json({ default_node_info: {} }),
      ManifestMCPErrorCode.INVALID_CONFIG,
    ],
    [
      'oversized',
      () => new Response('x'.repeat(65_537)),
      ManifestMCPErrorCode.INVALID_CONFIG,
    ],
  ] as const)(
    'fails closed on an %s REST identity response',
    async (_name, response, code) => {
      await expect(
        createManifestReadClient({
          config: CONFIG,
          chainIdentityFetch: vi.fn(async () => response()),
        }),
      ).rejects.toMatchObject({ code });
    },
  );
});
