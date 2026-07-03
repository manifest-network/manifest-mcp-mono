import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocked SDK surface (no docker) ───────────────────────────────────────────
// The flow composes ONLY `@manifest-network/manifest-sdk` (+ its `/deploy` subpath)
// and the sanctioned manifestjs codec. We mock those three module specifiers so the
// 8-step lifecycle runs entirely in-process: the mocked `createFredClient` returns a
// fake client whose bound methods are vi.fns, and the positional `/deploy` fns are
// vi.fns we assert against. This pins the COMPOSITION contract (denom-from-SKU, the
// positional-fred bridge, the double-fund batch, failure-terminal-rejects, single vs
// stack shaping) without a chain or a provider.

// Hoisted shared spies + runtime constants so both the factory mocks and the assertions see the same
// references (a vi.mock factory is hoisted above module-level consts, so everything it closes over must
// live in vi.hoisted). LeaseState mirrors the real runtime enum's relevant members; PROVISION_FAILED
// mirrors the real failure Set.
const h = vi.hoisted(() => {
  return {
    // ROOT
    createFredClient: vi.fn(),
    parseFqdn: vi.fn((s: string) => s),
    // /deploy positional fred fns + helpers
    deployApp: vi.fn(),
    getLeaseConnectionInfo: vi.fn(),
    restartApp: vi.fn(),
    updateApp: vi.fn(),
    getAppLogs: vi.fn(),
    buildManifest: vi.fn((x: unknown) => ({ single: x })),
    buildStackManifest: vi.fn((x: unknown) => ({ stack: x })),
    // manifestjs codec
    fromPartial: vi.fn((v: unknown) => v),
    // /deploy runtime values
    LeaseState: {
      LEASE_STATE_UNSPECIFIED: 0,
      LEASE_STATE_ACTIVE: 1,
      LEASE_STATE_CLOSED: 2,
      LEASE_STATE_REJECTED: 3,
      LEASE_STATE_EXPIRED: 4,
    } as const,
    PROVISION_FAILED: new Set(['PROVISION_STATUS_FAILED']),
  };
});

const LeaseState = h.LeaseState;

vi.mock('@manifest-network/manifest-sdk', () => ({
  createFredClient: h.createFredClient,
  parseFqdn: h.parseFqdn,
}));

vi.mock('@manifest-network/manifest-sdk/deploy', () => ({
  deployApp: h.deployApp,
  getLeaseConnectionInfo: h.getLeaseConnectionInfo,
  restartApp: h.restartApp,
  updateApp: h.updateApp,
  getAppLogs: h.getAppLogs,
  buildManifest: h.buildManifest,
  buildStackManifest: h.buildStackManifest,
  LeaseState: h.LeaseState,
  PROVISION_FAILED: h.PROVISION_FAILED,
}));

vi.mock(
  '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js',
  () => ({ MsgFundCredit: { fromPartial: h.fromPartial } }),
);

// Import AFTER the mocks are registered.
import { type AcceptanceOpts, runAcceptanceFlow } from './flow.js';

const ADDR = 'manifest1tenant';
const CREDIT_DENOM = 'factory/manifest1poaadmin/upwr';
const LEASE_UUID = 'lease-uuid-1234';
const PROVIDER_URL = 'https://provider.example:8443';

// A tiny ordered-call recorder so we can assert the 8 steps run in sequence.
let callLog: string[];

function buildFakeClient(opts: { onSubscribeComplete?: 'active' | 'failure' }) {
  const subscribeStop = vi.fn();
  const client = {
    // ctx fields
    chain: {
      getAddress: vi.fn(async () => {
        callLog.push('getAddress');
        return ADDR;
      }),
      getConfig: vi.fn(() => ({ chainId: 'manifest-devnet' })),
    },
    query: { __query: true },
    fetch: vi.fn(),
    providerAuth: {
      providerToken: vi.fn(async () => 'auth-token'),
      leaseDataToken: vi.fn(async () => 'lease-data-token'),
    },
    // bound reads
    getSKUs: vi.fn(async () => {
      callLog.push('getSKUs');
      return [
        {
          name: 'docker-nano',
          basePrice: { denom: 'umfx', amount: '1' },
        },
        {
          name: 'docker-micro',
          basePrice: { denom: CREDIT_DENOM, amount: '500' },
        },
      ];
    }),
    fundCredits: vi.fn(async (input: { amount: string }) => {
      callLog.push(`fundCredits:${input.amount}`);
      return {};
    }),
    getLeasesByTenant: vi.fn(
      async (input: { tenant: string; stateFilter: number }) => {
        callLog.push(`getLeasesByTenant:${input.stateFilter}`);
        return { leases: [], total: 0n };
      },
    ),
    getLease: vi.fn(async (uuid: string) => {
      callLog.push('getLease');
      return { uuid, items: [] };
    }),
    setItemCustomDomain: vi.fn(
      async (input: { leaseUuid: string; serviceName?: string }) => {
        callLog.push(`setItemCustomDomain:${input.serviceName ?? 'none'}`);
        return {};
      },
    ),
    executeTx: vi.fn(async (msgs: unknown[]) => {
      callLog.push(`executeTx:${msgs.length}`);
      return {};
    }),
    stopApp: vi.fn(async () => {
      callLog.push('stopApp');
      return {};
    }),
    subscribeLeaseStatus: vi.fn(
      (
        _uuid: string,
        subOpts: {
          onComplete?: (final: {
            state: number;
            provision_status?: string;
          }) => void;
          onError?: (e: unknown) => void;
        },
      ) => {
        callLog.push('subscribeLeaseStatus');
        // Fire onComplete asynchronously to mirror the real poll terminal.
        queueMicrotask(() => {
          if (opts.onSubscribeComplete === 'failure') {
            subOpts.onComplete?.({ state: LeaseState.LEASE_STATE_CLOSED });
          } else {
            subOpts.onComplete?.({ state: LeaseState.LEASE_STATE_ACTIVE });
          }
        });
        return subscribeStop;
      },
    ),
    dispose: vi.fn(() => {
      callLog.push('dispose');
    }),
  };
  return client;
}

// The flow only forwards config/walletProvider/fetch into the (mocked) createFredClient, so the test
// passes plain stand-ins cast to the real param types — never `as never` (that erases the spread shape).
const baseOpts = (): Pick<
  AcceptanceOpts,
  'config' | 'walletProvider' | 'fetch'
> => ({
  config: { chainId: 'manifest-devnet' } as AcceptanceOpts['config'],
  walletProvider: {
    __wallet: true,
  } as unknown as AcceptanceOpts['walletProvider'],
  fetch: vi.fn() as unknown as AcceptanceOpts['fetch'],
});

beforeEach(() => {
  vi.clearAllMocks();
  callLog = [];
  h.deployApp.mockResolvedValue({
    lease_uuid: LEASE_UUID,
    provider_url: PROVIDER_URL,
  });
  h.getLeaseConnectionInfo.mockResolvedValue({});
  h.restartApp.mockResolvedValue({});
  h.updateApp.mockResolvedValue({});
  h.getAppLogs.mockResolvedValue({ logs: {} });
});

describe('runAcceptanceFlow (mocked SDK)', () => {
  it('(a) builds createFredClient from {config, walletProvider, fetch}', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);
    const opts = baseOpts();

    await runAcceptanceFlow({ ...opts, variant: 'single' });

    expect(h.createFredClient).toHaveBeenCalledTimes(1);
    expect(h.createFredClient).toHaveBeenCalledWith({
      config: opts.config,
      walletProvider: opts.walletProvider,
      fetch: opts.fetch,
    });
  });

  it('(b) resolves the credit denom from getSKUs (docker-micro basePrice.denom) and funds with it', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);

    await runAcceptanceFlow({ ...baseOpts(), variant: 'single' });

    expect(client.getSKUs).toHaveBeenCalledTimes(1);
    // NOT umfx (gas) — the docker-micro SKU's price denom.
    expect(client.fundCredits).toHaveBeenCalledWith({
      amount: `5000000${CREDIT_DENOM}`,
    });
    expect(client.fundCredits).not.toHaveBeenCalledWith({
      amount: '5000000umfx',
    });
  });

  it('throws when docker-micro SKU is absent', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    client.getSKUs.mockResolvedValueOnce([
      { name: 'docker-nano', basePrice: { denom: 'umfx', amount: '1' } },
    ]);
    h.createFredClient.mockResolvedValue(client);

    await expect(
      runAcceptanceFlow({ ...baseOpts(), variant: 'single' }),
    ).rejects.toThrow(/docker-micro/);
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('(c) single: runs the 8 steps in order', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);

    await runAcceptanceFlow({ ...baseOpts(), variant: 'single' });

    // The recorded order of the side-effecting steps.
    expect(callLog).toEqual([
      'getAddress',
      'getSKUs',
      `fundCredits:5000000${CREDIT_DENOM}`,
      'getLeasesByTenant:1', // LEASE_STATE_ACTIVE
      'getLease',
      'setItemCustomDomain:none',
      'executeTx:2',
      'subscribeLeaseStatus',
      'stopApp',
      'dispose',
    ]);
    // deployApp (positional) ran before the query step.
    expect(h.deployApp).toHaveBeenCalledTimes(1);
    expect(h.getLeaseConnectionInfo).toHaveBeenCalledTimes(1);
    expect(h.restartApp).toHaveBeenCalledTimes(1);
    expect(h.updateApp).toHaveBeenCalledTimes(1);
    expect(h.getAppLogs).toHaveBeenCalledTimes(1);
  });

  it('(c/single) single uses buildManifest and a port-shaped spec (no services, no serviceName)', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);

    await runAcceptanceFlow({ ...baseOpts(), variant: 'single' });

    // deployApp args: (ctx, spec, callOptions) — spec is the 2nd positional.
    const spec = h.deployApp.mock.calls[0][1] as {
      image?: string;
      port?: number;
      services?: unknown;
    };
    expect(spec.image).toBeDefined();
    expect(spec.port).toBe(8080);
    expect(spec.services).toBeUndefined();
    // single → setItemCustomDomain with NO serviceName
    expect(client.setItemCustomDomain).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: undefined }),
    );
    // single → buildManifest for the update, NOT buildStackManifest
    expect(h.buildManifest).toHaveBeenCalledTimes(1);
    expect(h.buildStackManifest).not.toHaveBeenCalled();
  });

  it('(d) stack: deploys a {services:{…}} spec, passes serviceName:"web", uses buildStackManifest', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);

    await runAcceptanceFlow({ ...baseOpts(), variant: 'stack' });

    const spec = h.deployApp.mock.calls[0][1] as {
      services?: Record<string, unknown>;
      image?: string;
    };
    expect(spec.services).toBeDefined();
    expect(Object.keys(spec.services ?? {})).toContain('web');
    expect(spec.image).toBeUndefined();
    expect(client.setItemCustomDomain).toHaveBeenCalledWith(
      expect.objectContaining({ serviceName: 'web' }),
    );
    expect(h.buildStackManifest).toHaveBeenCalledTimes(1);
    expect(h.buildManifest).not.toHaveBeenCalled();
  });

  it('(e) executeTx batch is two MsgFundCredit EncodeObjects with sender===tenant===addr and the SKU denom', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);

    await runAcceptanceFlow({ ...baseOpts(), variant: 'single' });

    const msgs = client.executeTx.mock.calls[0][0] as Array<{
      typeUrl: string;
      value: unknown;
    }>;
    expect(msgs).toHaveLength(2);
    for (const m of msgs) {
      expect(m.typeUrl).toBe('/liftedinit.billing.v1.MsgFundCredit');
    }
    // The codec was handed sender===tenant===addr + the SKU denom.
    expect(h.fromPartial).toHaveBeenCalledTimes(2);
    for (const call of h.fromPartial.mock.calls) {
      expect(call[0]).toMatchObject({
        sender: ADDR,
        tenant: ADDR,
        amount: { denom: CREDIT_DENOM, amount: '1' },
      });
    }
  });

  it('(f) getLeasesByTenant is called with stateFilter LEASE_STATE_ACTIVE', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);

    await runAcceptanceFlow({ ...baseOpts(), variant: 'single' });

    expect(client.getLeasesByTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: ADDR,
        stateFilter: LeaseState.LEASE_STATE_ACTIVE,
      }),
    );
  });

  it('(g) subscribe RESOLVES on an ACTIVE terminal', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);

    await expect(
      runAcceptanceFlow({ ...baseOpts(), variant: 'single' }),
    ).resolves.toBeUndefined();
    // reached stopApp + dispose (did not reject before)
    expect(client.stopApp).toHaveBeenCalledTimes(1);
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('(f′) subscribe REJECTS on a FAILURE terminal (CLOSED) — a failed deploy must NOT false-green', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'failure' });
    h.createFredClient.mockResolvedValue(client);

    await expect(
      runAcceptanceFlow({ ...baseOpts(), variant: 'single' }),
    ).rejects.toThrow(/FAILURE terminal/);
    // stopApp must NOT have run (we rejected at step 7); dispose still runs (finally).
    expect(client.stopApp).not.toHaveBeenCalled();
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('(f′) subscribe REJECTS on a PROVISION_FAILED provision_status even when state is ACTIVE', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    client.subscribeLeaseStatus.mockImplementationOnce(
      (
        _uuid: string,
        subOpts: {
          onComplete?: (final: {
            state: number;
            provision_status?: string;
          }) => void;
        },
      ) => {
        callLog.push('subscribeLeaseStatus');
        queueMicrotask(() => {
          subOpts.onComplete?.({
            state: LeaseState.LEASE_STATE_ACTIVE,
            provision_status: 'PROVISION_STATUS_FAILED',
          });
        });
        return vi.fn();
      },
    );
    h.createFredClient.mockResolvedValue(client);

    await expect(
      runAcceptanceFlow({ ...baseOpts(), variant: 'single' }),
    ).rejects.toThrow(/FAILURE terminal/);
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });

  it('(h) a 409 from restart is retried, then succeeds', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);
    const err409 = Object.assign(new Error('invalid state'), { status: 409 });
    h.restartApp.mockRejectedValueOnce(err409).mockResolvedValueOnce({});

    await runAcceptanceFlow({ ...baseOpts(), variant: 'single' });

    expect(h.restartApp).toHaveBeenCalledTimes(2);
  });

  it('(h) a non-409 from restart is NOT retried (propagates)', async () => {
    const client = buildFakeClient({ onSubscribeComplete: 'active' });
    h.createFredClient.mockResolvedValue(client);
    const err500 = Object.assign(new Error('boom'), { status: 500 });
    h.restartApp.mockRejectedValue(err500);

    await expect(
      runAcceptanceFlow({ ...baseOpts(), variant: 'single' }),
    ).rejects.toThrow(/boom/);
    expect(h.restartApp).toHaveBeenCalledTimes(1);
    // dispose still runs on the failure path.
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });
});
