// This file mocks NOTHING (ENG-725).
//
// It used to `vi.mock('../http/fred.js')` for `restartLease` + `pollLeaseUntilReady`, and
// `vi.mock('./resolveLeaseProvider.js')` for the lookup. All gone: the wire is injected at
// `ctx.fetch`, so the REAL restart POST, the REAL readiness poll and the REAL provider-URL SSRF
// check run on every case.
//
// That upgrades three claims from shape to behaviour. "The poll got a token FUNCTION" becomes
// "the token is re-minted on every iteration" (counted). "pollOptions was threaded" becomes
// "`onProgress` actually fired". "No poll happened" becomes "no `/status` request was made" —
// exact, because the probe is default-deny and records everything.
//
// The poll needs no fake timers: `/status` answers ready on the first read, so the loop exits
// before it ever sleeps.
import { LeaseState, noopLogger } from '@manifest-network/manifest-mcp-core';
import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FredAuthCtx } from '../ctx.js';
import { restartApp } from './restartApp.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_URL = 'https://provider.example.com';
const ADDR = 'manifest1abc';

const READY = { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' };
const PENDING = { state: 'LEASE_STATE_PENDING' };

const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

let wire: ReturnType<typeof sealedFetchProbe>;

/** Route the two endpoints a restart touches. `status` may be a script, so a poll can iterate. */
function routeWire(status: unknown = READY): void {
  wire = sealedFetchProbe({
    '/restart': { json: { status: 'restarting' } },
    '/status': (Array.isArray(status)
      ? status.map((s) => ({ json: s }))
      : { json: status }) as never,
  });
}

function activeQc(state = LeaseState.LEASE_STATE_ACTIVE) {
  return makeMockQueryClient({
    billing: { lease: { uuid: LEASE_UUID, state, providerUuid: 'prov-1' } },
    sku: {
      providerLookup: { 'prov-1': { provider: { apiUrl: PROVIDER_URL } } },
    },
  });
}

function makeCtx(qc: ReturnType<typeof makeMockQueryClient>): FredAuthCtx {
  return {
    query: qc as never,
    chain: {} as never,
    fetch: wire.fetch,
    logger: noopLogger,
    providerAuth: {
      providerToken: (i: { address: string; leaseUuid: string }) =>
        mockGetAuthToken(i.address, i.leaseUuid),
      leaseDataToken: vi.fn(),
    },
  };
}

/** Requests the probe saw, by route key. */
function urls(): string[] {
  return wire.calls.map((c) => new URL(c.url).pathname.split('/').pop() ?? '');
}

describe('restartApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthToken.mockResolvedValue('auth-token');
    routeWire();
  });

  it('default: resolves lease + provider, restarts, then polls to ready', async () => {
    const result = await restartApp(makeCtx(activeQc()), {
      address: ADDR,
      leaseUuid: LEASE_UUID,
    });

    expect(urls()).toEqual(['restart', 'status']);
    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/restart`,
    );
    expect(wire.calls[0]?.init.method).toBe('POST');
    const headers = wire.calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer auth-token');
    expect(result).toEqual({
      lease_uuid: LEASE_UUID,
      status: 'restarting',
      ready: {
        state: LeaseState.LEASE_STATE_ACTIVE,
        provision_status: 'ready',
      },
    });
  });

  it('pollOptions:false → fire-and-return, no /status request, no ready field', async () => {
    const result = await restartApp(
      makeCtx(activeQc()),
      { address: ADDR, leaseUuid: LEASE_UUID },
      { pollOptions: false },
    );

    // `/status` IS routed, so this counts requests rather than relying on a refusal.
    expect(urls()).toEqual(['restart']);
    expect(result).toEqual({ lease_uuid: LEASE_UUID, status: 'restarting' });
  });

  it('fast path: supplied providerUrl skips fetchActiveLease + resolveProviderUrl', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    const leaseFn = qc.liftedinit.billing.v1.lease;
    const providerFn = qc.liftedinit.sku.v1.provider;

    const result = await restartApp(
      makeCtx(qc),
      { address: ADDR, leaseUuid: LEASE_UUID },
      { providerUrl: PROVIDER_URL },
    );

    expect(leaseFn).not.toHaveBeenCalled();
    expect(providerFn).not.toHaveBeenCalled();
    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/restart`,
    );
    expect(result.ready?.provision_status).toBe('ready');
  });

  it('re-mints the auth token on every poll iteration', async () => {
    // Was "the poll received a token FUNCTION" — a shape assertion that could pass while the
    // function was called once and cached. This counts the mints instead: 1 for the POST plus
    // 1 per poll read. ADR-036 tokens are deterministic, so a reused one is replay-rejected.
    routeWire([PENDING, PENDING, READY]);

    await restartApp(
      makeCtx(activeQc()),
      { address: ADDR, leaseUuid: LEASE_UUID },
      { pollOptions: { intervalMs: 0 } },
    );

    expect(urls()).toEqual(['restart', 'status', 'status', 'status']);
    expect(mockGetAuthToken).toHaveBeenCalledTimes(4);
    expect(mockGetAuthToken).toHaveBeenLastCalledWith(ADDR, LEASE_UUID);
  });

  it('threads pollOptions: onProgress fires for each polled status', async () => {
    // Was "pollOpts was passed through". Now the option is observed DOING something.
    const onProgress = vi.fn();
    routeWire([PENDING, READY]);

    await restartApp(
      makeCtx(activeQc()),
      { address: ADDR, leaseUuid: LEASE_UUID },
      { pollOptions: { onProgress, intervalMs: 0 } },
    );

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ provision_status: 'ready' }),
    );
  });

  it('threads abortSignal into the poll', async () => {
    const ac = new AbortController();
    routeWire([PENDING, READY]);

    const pending = restartApp(
      makeCtx(activeQc()),
      { address: ADDR, leaseUuid: LEASE_UUID },
      {
        pollOptions: { intervalMs: 10_000, onProgress: () => ac.abort() },
        abortSignal: ac.signal,
      },
    );

    // Aborting from the first onProgress cancels the interval sleep rather than waiting 10s.
    await expect(pending).rejects.toThrow();
    expect(urls()).toEqual(['restart', 'status']);
  });

  it('pre-aborted signal → throws before the mutate POST', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      restartApp(
        makeCtx(activeQc()),
        { address: ADDR, leaseUuid: LEASE_UUID },
        { abortSignal: ac.signal },
      ),
    ).rejects.toThrow();
    // Nothing reached the provider at all — exact, because the probe records every request.
    expect(wire.calls).toHaveLength(0);
  });

  it('abort DURING providerUrl resolution → the mutate POST is not fired', async () => {
    const ac = new AbortController();
    const qc = activeQc();
    // Abort from inside the on-chain provider lookup: after restartApp's top guard, before the
    // pre-POST fence. Wrapping the query keeps the exact window the old resolveProviderUrl mock
    // targeted, without mocking the tool module.
    const realProvider = qc.liftedinit.sku.v1.provider;
    qc.liftedinit.sku.v1.provider = vi.fn(async (req: { uuid: string }) => {
      ac.abort();
      return realProvider(req);
    }) as never;

    await expect(
      restartApp(
        makeCtx(qc),
        { address: ADDR, leaseUuid: LEASE_UUID },
        { abortSignal: ac.signal },
      ),
    ).rejects.toThrow();
    expect(wire.calls).toHaveLength(0);
  });

  it('default path still throws when lease is not active', async () => {
    await expect(
      restartApp(makeCtx(activeQc(LeaseState.LEASE_STATE_CLOSED)), {
        address: ADDR,
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toThrow('cannot be restarted');
    expect(wire.calls).toHaveLength(0);
  });
});
