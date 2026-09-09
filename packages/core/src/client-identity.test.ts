import { toBech32 } from '@cosmjs/encoding';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { cosmwasm } from '@manifest-network/manifestjs/dist/codegen/cosmwasm/bundle.js';
import { ibc } from '@manifest-network/manifestjs/dist/codegen/ibc/bundle.js';
import { liftedinit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/bundle.js';
import { osmosis } from '@manifest-network/manifestjs/dist/codegen/osmosis/bundle.js';
import { strangelove_ventures } from '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/bundle.js';
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

function rpcStatus(chainId = CHAIN_ID) {
  return {
    jsonrpc: '2.0',
    id: 'manifest-chain-identity',
    result: { node_info: { network: chainId } },
  };
}

function rpcFetch(chainId = CHAIN_ID) {
  return vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(rpcStatus(chainId)),
  );
}

function stubRpcFactories() {
  const balance = vi.fn(async () => ({
    balance: { denom: 'umfx', amount: '42' },
  }));
  // Replace transport construction only; the public clients and identity/retry
  // lifecycle run unchanged. Minimal module fixtures keep every query off the wire.
  const factories = [
    vi
      .spyOn(liftedinit.ClientFactory, 'createRPCQueryClient')
      .mockResolvedValue({
        cosmos: { bank: { v1beta1: { balance } } },
      } as unknown as Awaited<
        ReturnType<typeof liftedinit.ClientFactory.createRPCQueryClient>
      >),
    vi.spyOn(cosmwasm.ClientFactory, 'createRPCQueryClient').mockResolvedValue({
      cosmwasm: {},
    } as Awaited<
      ReturnType<typeof cosmwasm.ClientFactory.createRPCQueryClient>
    >),
    vi
      .spyOn(strangelove_ventures.ClientFactory, 'createRPCQueryClient')
      .mockResolvedValue({
        strangelove_ventures: {},
      } as Awaited<
        ReturnType<
          typeof strangelove_ventures.ClientFactory.createRPCQueryClient
        >
      >),
    vi.spyOn(osmosis.ClientFactory, 'createRPCQueryClient').mockResolvedValue({
      osmosis: {},
    } as Awaited<
      ReturnType<typeof osmosis.ClientFactory.createRPCQueryClient>
    >),
    vi.spyOn(ibc.ClientFactory, 'createRPCQueryClient').mockResolvedValue({
      ibc: {},
    } as Awaited<ReturnType<typeof ibc.ClientFactory.createRPCQueryClient>>),
  ];
  return { factories, balance };
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
  it('rejects a mismatched RPC-only read endpoint before constructing any query namespace', async () => {
    const factories = [
      liftedinit.ClientFactory,
      cosmwasm.ClientFactory,
      strangelove_ventures.ClientFactory,
      osmosis.ClientFactory,
      ibc.ClientFactory,
    ].map((factory) =>
      vi
        .spyOn(factory, 'createRPCQueryClient')
        .mockRejectedValue(
          new Error('Query factory must not run before identity validation'),
        ),
    );
    const identityFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 'manifest-chain-identity',
        result: { node_info: { network: 'wrong-chain' } },
      }),
    );
    await expect(
      createManifestReadClient({
        config: { ...CONFIG, restUrl: undefined },
        chainIdentityFetch: identityFetch,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      details: { expectedChainId: CHAIN_ID, actualChainId: 'wrong-chain' },
    });
    expect(identityFetch).toHaveBeenCalledOnce();
    for (const factory of factories) expect(factory).not.toHaveBeenCalled();
  });

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

describe('RPC-only public query identity', () => {
  const rpcConfig = { ...CONFIG, restUrl: undefined };
  let rpc: ReturnType<typeof stubRpcFactories>;

  beforeEach(() => {
    rpc = stubRpcFactories();
  });

  it('verifies the exact gateway URL, exposes working queries, and reuses the verified cache', async () => {
    const rpcUrl = 'https://rpc.example.com/gateway/v1?tenant=example';
    const identityFetch = rpcFetch();
    const providerFetch = vi.fn<typeof globalThis.fetch>();
    const client = await createManifestReadClient({
      config: { ...rpcConfig, rpcUrl },
      chainIdentityFetch: identityFetch,
      fetch: providerFetch,
    });
    expect(identityFetch).toHaveBeenCalledOnce();
    expect(identityFetch).toHaveBeenCalledWith(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'manifest-chain-identity',
        method: 'status',
        params: {},
      }),
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    for (const factory of rpc.factories) {
      expect(factory).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledWith({ rpcEndpoint: rpcUrl });
    }
    await expect(
      client.query.cosmos.bank.v1beta1.balance({
        address: ADDRESS_A,
        denom: 'umfx',
      }),
    ).resolves.toEqual({ balance: { denom: 'umfx', amount: '42' } });
    await expect(client.chain.getQueryClient()).resolves.toBe(client.query);
    expect(identityFetch).toHaveBeenCalledOnce();
    expect(providerFetch).not.toHaveBeenCalled();
    await expect(client.chain.getSigningClient()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
    });
    client.dispose();
  });

  it.each([
    ['missing network', { ...rpcStatus(), result: { node_info: {} } }],
    ['empty network', rpcStatus('')],
    ['overlong network', rpcStatus('x'.repeat(257))],
    [
      'non-string network',
      { ...rpcStatus(), result: { node_info: { network: 1 } } },
    ],
    ['missing result', { jsonrpc: '2.0', id: 'manifest-chain-identity' }],
    ['wrong protocol version', { ...rpcStatus(), jsonrpc: '1.0' }],
    [
      'missing protocol version',
      { id: 'manifest-chain-identity', result: rpcStatus().result },
    ],
    ['wrong request id', { ...rpcStatus(), id: 'different-request' }],
    ['missing request id', { jsonrpc: '2.0', result: rpcStatus().result }],
    [
      'RPC error',
      { ...rpcStatus(), error: { code: -32603, message: 'unavailable' } },
    ],
    ['null RPC error', { ...rpcStatus(), error: null }],
  ])('rejects %s before creating query namespaces', async (_name, response) => {
    await expect(
      createManifestReadClient({
        config: rpcConfig,
        chainIdentityFetch: vi.fn(async () => Response.json(response)),
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    for (const factory of rpc.factories) expect(factory).not.toHaveBeenCalled();
  });

  it('rejects non-JSON status without constructing queries', async () => {
    await expect(
      createManifestReadClient({
        config: rpcConfig,
        chainIdentityFetch: vi.fn(
          async () => new Response('<html>not a node</html>'),
        ),
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    for (const factory of rpc.factories) expect(factory).not.toHaveBeenCalled();
  });

  it.each([401, 503])(
    'fails closed on HTTP %i from the status endpoint',
    async (status) => {
      await expect(
        createManifestReadClient({
          config: rpcConfig,
          chainIdentityFetch: vi.fn(async () => new Response(null, { status })),
        }),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      });
      for (const factory of rpc.factories)
        expect(factory).not.toHaveBeenCalled();
    },
  );

  it('fails closed on transport rejection without constructing queries', async () => {
    await expect(
      createManifestReadClient({
        config: rpcConfig,
        chainIdentityFetch: vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    });
    for (const factory of rpc.factories) expect(factory).not.toHaveBeenCalled();
  });

  it('shares a pending identity verification across compatible public clients', async () => {
    let resolveIdentity!: (response: Response) => void;
    const identityFetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        }),
    );
    const opts = {
      config: rpcConfig,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: identityFetch,
    };
    const first = createManifestClient(opts);
    const second = createManifestClient(opts);
    expect(identityFetch).toHaveBeenCalledOnce();
    for (const factory of rpc.factories) expect(factory).not.toHaveBeenCalled();
    resolveIdentity(Response.json(rpcStatus()));
    const [a, b] = await Promise.all([first, second]);
    expect(a.chain).toBe(b.chain);
    expect(a.query).toBe(b.query);
    for (const factory of rpc.factories) expect(factory).toHaveBeenCalledOnce();
    a.dispose();
    await expect(b.chain.getQueryClient()).resolves.toBe(b.query);
    expect(identityFetch).toHaveBeenCalledOnce();
    b.dispose();
  });

  it('revalidates a replacement and can recover after its identity check fails', async () => {
    const identityFetch = rpcFetch();
    const opts = {
      config: rpcConfig,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: identityFetch,
    };
    const original = await createManifestClient(opts);
    original.dispose();
    identityFetch.mockResolvedValueOnce(
      Response.json(rpcStatus('replaced-chain')),
    );
    await expect(createManifestClient(opts)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      details: { actualChainId: 'replaced-chain' },
    });
    for (const factory of rpc.factories) expect(factory).toHaveBeenCalledOnce();
    const recovered = await createManifestClient(opts);
    expect(recovered.chain).not.toBe(original.chain);
    expect(identityFetch).toHaveBeenCalledTimes(3);
    for (const factory of rpc.factories)
      expect(factory).toHaveBeenCalledTimes(2);
    recovered.dispose();
  });

  it('retries transient identity failures before initializing namespaces', async () => {
    const identityFetch = rpcFetch().mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );
    const client = await createManifestReadClient({
      config: {
        ...rpcConfig,
        retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
      },
      chainIdentityFetch: identityFetch,
    });
    expect(identityFetch).toHaveBeenCalledTimes(2);
    for (const factory of rpc.factories) expect(factory).toHaveBeenCalledOnce();
    client.dispose();
  });

  it('rechecks identity before retrying failed namespace initialization', async () => {
    rpc.factories[0].mockRejectedValueOnce(new TypeError('fetch failed'));
    const identityFetch = rpcFetch()
      .mockResolvedValueOnce(Response.json(rpcStatus()))
      .mockResolvedValueOnce(Response.json(rpcStatus('changed-on-retry')));
    await expect(
      createManifestReadClient({
        config: {
          ...rpcConfig,
          retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        },
        chainIdentityFetch: identityFetch,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      details: { actualChainId: 'changed-on-retry' },
    });
    expect(identityFetch).toHaveBeenCalledTimes(2);
    for (const factory of rpc.factories) expect(factory).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'body'] as const)(
    'retries an identity deadline reached during %s before exposing queries',
    async (phase) => {
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
      let started!: () => void;
      const pending = new Promise<void>((resolve) => {
        started = resolve;
      });
      const identityFetch = rpcFetch().mockImplementationOnce(
        async (_input, init) => {
          if (phase === 'fetch') {
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(init.signal?.reason),
                { once: true },
              );
              started();
            });
          }
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                start(stream) {
                  init?.signal?.addEventListener(
                    'abort',
                    () => stream.error(init.signal?.reason),
                    { once: true },
                  );
                },
                pull() {
                  started();
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
      );
      const initializing = createManifestReadClient({
        config: {
          ...rpcConfig,
          retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        },
        chainIdentityFetch: identityFetch,
      });
      await pending;
      for (const factory of rpc.factories)
        expect(factory).not.toHaveBeenCalled();
      // Native AbortSignal.timeout prose does not include "timed out"; it must still retry.
      deadline.abort(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError',
        ),
      );
      const client = await initializing;
      expect(identityFetch).toHaveBeenCalledTimes(2);
      for (const factory of rpc.factories)
        expect(factory).toHaveBeenCalledOnce();
      client.dispose();
    },
  );

  it('prefers REST identity and LCD queries when both endpoints are configured', async () => {
    const identityFetch = chainFetch();
    const client = await createManifestReadClient({
      config: CONFIG,
      chainIdentityFetch: identityFetch,
    });
    expect(identityFetch).toHaveBeenCalledOnce();
    expect(identityFetch).toHaveBeenCalledWith(
      'https://rest.example.com/prefix/cosmos/base/tendermint/v1beta1/node_info',
      expect.not.objectContaining({ method: 'POST' }),
    );
    for (const factory of rpc.factories) expect(factory).not.toHaveBeenCalled();
    client.dispose();
  });

  it('still checks the actual signing connection after RPC query identity succeeds', async () => {
    const wire = transport('different-signing-chain');
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
      wire as unknown as SigningStargateClient,
    );
    const identityFetch = rpcFetch();
    const client = await createManifestClient({
      config: rpcConfig,
      walletProvider: wallet(ADDRESS_A),
      chainIdentityFetch: identityFetch,
    });
    await expect(
      client.executeTx([MESSAGE], { fee: FEE }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      details: { actualChainId: 'different-signing-chain' },
    });
    expect(wire.disconnect).toHaveBeenCalledOnce();
    expect(wire.signAndBroadcast).not.toHaveBeenCalled();
    expect(identityFetch).toHaveBeenCalledOnce();
    client.dispose();
  });
});
