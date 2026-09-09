import { toBech32 } from '@cosmjs/encoding';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asFqdn, asLeaseUuid } from './brands.js';
import { CosmosClientManager } from './client.js';
import { createManifestClient, type ManifestClient } from './client-full.js';
import { cosmosTx } from './cosmos.js';
import type { TxCallOptions } from './options.js';
import {
  type ManifestMCPConfig,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from './types.js';

vi.mock('./lcd-adapter.js', () => ({
  createLCDQueryClient: vi.fn(async () => ({
    liftedinit: {
      billing: { v1: { lease: async () => ({ lease: { state: 2 } }) } },
    },
  })),
}));

const ADDRESS = toBech32('manifest', new Uint8Array(20).fill(1));
const LEASE = asLeaseUuid('550e8400-e29b-41d4-a716-446655440000');
const MESSAGES = [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: {} }];
const FEE = { amount: [], gas: '100' };
const CONFIG = {
  chainId: 'cancellation-test',
  rpcUrl: 'https://rpc.example.com',
  restUrl: 'https://rest.example.com',
  gasPrice: '0.025umfx',
  retry: { maxRetries: 0 },
};
const RESULT = {
  code: 0,
  transactionHash: 'hash',
  height: 1,
  gasUsed: 1n,
  gasWanted: 1n,
  events: [],
  msgResponses: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function wireClient() {
  return {
    getChainId: vi.fn(async () => CONFIG.chainId),
    disconnect: vi.fn(),
    defaultGasMultiplier: 1.4,
    simulate: vi.fn(async () => 100),
    signAndBroadcast: vi.fn(async () => RESULT),
    signAndBroadcastSync: vi.fn(async () => 'hash'),
  };
}

async function client(config: ManifestMCPConfig = CONFIG) {
  const signer: OfflineSigner = {
    getAccounts: async () => [],
    signDirect: vi.fn(),
  };
  return createManifestClient({
    config,
    walletProvider: {
      getAddress: async () => ADDRESS,
      getSigner: async () => signer,
    },
    chainIdentityFetch: vi.fn(async () =>
      Response.json({ default_node_info: { network: config.chainId } }),
    ),
  });
}

const ACTIONS: {
  name: string;
  run: (client: ManifestClient, opts: TxCallOptions) => Promise<unknown>;
}[] = [
  { name: 'executeTx', run: (c, opts) => c.executeTx(MESSAGES, opts) },
  {
    name: 'cosmosTx',
    run: (c, opts) =>
      cosmosTx(
        c.chain,
        'billing',
        'fund-credit',
        [ADDRESS, '1umfx'],
        true,
        undefined,
        { fee: opts.fee },
        opts,
      ),
  },
  {
    name: 'fundCredits',
    run: (c, opts) => c.fundCredits({ amount: '1umfx' }, opts),
  },
  {
    name: 'setItemCustomDomain',
    run: (c, opts) =>
      c.setItemCustomDomain(
        { leaseUuid: LEASE, customDomain: asFqdn('app.example.com') },
        opts,
      ),
  },
  { name: 'stopApp', run: (c, opts) => c.stopApp({ leaseUuid: LEASE }, opts) },
];

afterEach(() => {
  CosmosClientManager.clearInstances();
  vi.restoreAllMocks();
});

describe('transaction cancellation at the public boundary', () => {
  it.each(ACTIONS)(
    '$name cancels a queued operation without sending after the lock is released',
    async ({ run }) => {
      const wire = wireClient();
      const connect = vi
        .spyOn(SigningStargateClient, 'connectWithSigner')
        .mockResolvedValue(wire as unknown as SigningStargateClient);
      const c = await client();
      const lock = vi.spyOn(c.chain, 'withBroadcastLock');
      const held = deferred<void>();
      const pendingLock = c.chain.withBroadcastLock(
        ADDRESS,
        () => held.promise,
      );
      const abort = new AbortController();
      const result = run(c, { signal: abort.signal, fee: FEE }).catch(
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(lock).toHaveBeenCalledTimes(2), {
        interval: 1,
      });
      abort.abort(new Error('user cancelled queued operation'));
      await expect(result).resolves.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
        details: { sent: false },
      });
      held.resolve();
      await pendingLock;
      // A barrier behind the cancelled operation proves its abandoned callback has drained.
      await c.chain.withBroadcastLock(ADDRESS, async () => undefined);
      expect(connect).not.toHaveBeenCalled();
      expect(wire.signAndBroadcast).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it('cancellation during signing-client acquisition prevents a later broadcast', async () => {
    const wire = wireClient();
    const connected = deferred<SigningStargateClient>();
    const started = deferred<void>();
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockImplementation(
      () => {
        started.resolve();
        return connected.promise;
      },
    );
    const c = await client();
    const abort = new AbortController();
    const result = c
      .executeTx(MESSAGES, { signal: abort.signal, fee: FEE })
      .catch((error: unknown) => error);
    await started.promise;
    abort.abort();
    await expect(result).resolves.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      details: { sent: false },
    });
    connected.resolve(wire as unknown as SigningStargateClient);
    await c.chain.withBroadcastLock(ADDRESS, async () => undefined);
    expect(wire.signAndBroadcast).not.toHaveBeenCalled();
    c.dispose();
  });

  it('cancels the rate-limit wait without consuming a future token or submitting', async () => {
    const wire = wireClient();
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
      wire as unknown as SigningStargateClient,
    );
    const c = await client({
      ...CONFIG,
      rateLimit: { requestsPerSecond: 1 },
    });
    await c.chain.acquireRateLimit();
    const acquire = vi.spyOn(c.chain, 'acquireRateLimit');
    const abort = new AbortController();
    const result = c
      .executeTx(MESSAGES, { signal: abort.signal, fee: FEE })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledWith(abort.signal), {
      interval: 1,
    });
    abort.abort();
    await expect(result).resolves.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      details: { sent: false },
    });
    await c.chain.withBroadcastLock(ADDRESS, async () => undefined);
    expect(wire.signAndBroadcast).not.toHaveBeenCalled();
    expect(wire.simulate).not.toHaveBeenCalled();
    c.dispose();
  });

  it.each(ACTIONS)(
    '$name cannot submit after cancellation during simulation',
    async ({ run }) => {
      const wire = wireClient();
      const simulation = deferred<number>();
      const started = deferred<void>();
      wire.simulate.mockImplementation(() => {
        started.resolve();
        return simulation.promise;
      });
      vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
        wire as unknown as SigningStargateClient,
      );
      const c = await client();
      const abort = new AbortController();
      const result = run(c, { signal: abort.signal }).catch(
        (error: unknown) => error,
      );
      await started.promise;
      abort.abort();
      await expect(result).resolves.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
        details: { sent: false },
      });
      simulation.resolve(100);
      await c.chain.withBroadcastLock(ADDRESS, async () => undefined);
      expect(wire.signAndBroadcast).not.toHaveBeenCalled();
      c.dispose();
    },
  );

  it.each(ACTIONS)(
    '$name reports an unknown outcome after the signing/broadcast operation starts',
    async ({ run }) => {
      const wire = wireClient();
      const broadcast = deferred<typeof RESULT>();
      const started = deferred<void>();
      wire.signAndBroadcast.mockImplementation(() => {
        started.resolve();
        return broadcast.promise;
      });
      vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
        wire as unknown as SigningStargateClient,
      );
      const c = await client();
      const abort = new AbortController();
      const result = run(c, { signal: abort.signal, fee: FEE }).catch(
        (error: unknown) => error,
      );
      await started.promise;
      abort.abort();
      await expect(result).resolves.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
        details: { sent: true },
        message: expect.stringContaining('re-query'),
      });
      broadcast.resolve(RESULT);
      await c.chain.withBroadcastLock(ADDRESS, async () => undefined);
      expect(wire.signAndBroadcast).toHaveBeenCalledOnce();
      c.dispose();
    },
  );

  it('does not resume simulation or broadcast when cancelled between retry attempts', async () => {
    const wire = wireClient();
    wire.simulate.mockRejectedValueOnce(
      new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        'HTTP 503 temporarily unavailable',
      ),
    );
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
      wire as unknown as SigningStargateClient,
    );
    const c = await client({
      ...CONFIG,
      retry: { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 100 },
    });
    const abort = new AbortController();
    const result = c
      .executeTx(MESSAGES, { signal: abort.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(wire.simulate).toHaveBeenCalledOnce(), {
      interval: 1,
    });
    abort.abort();
    await expect(result).resolves.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      details: { sent: false },
    });
    await c.chain.withBroadcastLock(ADDRESS, async () => undefined);
    expect(wire.simulate).toHaveBeenCalledOnce();
    expect(wire.signAndBroadcast).not.toHaveBeenCalled();
    c.dispose();
  });

  it.each(ACTIONS)('$name resolves one operation timeout', async ({ run }) => {
    const wire = wireClient();
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
      wire as unknown as SigningStargateClient,
    );
    const c = await client();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await run(c, { timeout: 1_000, fee: FEE });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(1_000);
    c.dispose();
  });
});
