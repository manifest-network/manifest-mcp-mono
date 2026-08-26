// This file mocks NOTHING (ENG-725).
//
// It used to `vi.mock` THREE modules — `../http/fred.js`, `../http/provider.js` and
// `./resolveLeaseProvider.js`. All gone: the wire is injected at `ctx.fetch` as a sealed probe.
//
// That matters most for the sanitization cases below (ENG-555/ENG-638). They exist to prove that
// hostile provider text cannot reach model context raw, and they used to hand `appStatus` an
// already-parsed JavaScript object straight from a mock — skipping the JSON parse, the wire types,
// and `getLeaseStatus`'s own `leaseStateFromJSON` conversion. Now the bidi payload travels as
// actual JSON over the actual transport, which is the path a real provider would use to deliver it.
//
// `appStatus` reads status and connection concurrently under `Promise.allSettled`, so the two
// requests race. Assertions locate a request by URL rather than by index.
import {
  INFRASTRUCTURE_ERROR_CODES,
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FredAuthCtx } from '../ctx.js';
import { appStatus } from './appStatus.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_URL = 'https://provider.example.com';
const ADDR = 'manifest1abc';
/** RIGHT-TO-LEFT OVERRIDE. Written as an escape, never as a literal glyph. */
const BIDI = String.fromCharCode(0x202e);

const CONNECTION = {
  lease_uuid: LEASE_UUID,
  tenant: ADDR,
  provider_uuid: 'prov-1',
  connection: {
    host: 'app.example.com',
    ports: { '80/tcp': { host_ip: '0.0.0.0', host_port: 8080 } },
  },
};

const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

let wire: ReturnType<typeof sealedFetchProbe>;

/** Route both endpoints appStatus may read. Either may be a non-2xx descriptor. */
function routeWire(
  status: unknown = {
    state: 'LEASE_STATE_ACTIVE',
    services: { web: { instances: [{ name: 'web-0', status: 'running' }] } },
  },
  connection: unknown = CONNECTION,
): void {
  const step = (v: unknown) =>
    (v && typeof v === 'object' && 'status' in (v as object)
      ? v
      : { json: v }) as never;
  wire = sealedFetchProbe({
    '/status': step(status),
    '/connection': step(connection),
  });
}

function makeQc(state = LeaseState.LEASE_STATE_ACTIVE, items?: unknown[]) {
  return makeMockQueryClient({
    billing: {
      lease: {
        uuid: LEASE_UUID,
        state,
        providerUuid: 'prov-1',
        ...(items !== undefined && { items }),
      },
    },
    sku: {
      providerLookup: { 'prov-1': { provider: { apiUrl: PROVIDER_URL } } },
    },
  });
}

function makeCtx(
  qc: ReturnType<typeof makeMockQueryClient>,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string> = (
    a,
    l,
  ) => mockGetAuthToken(a, l),
): FredAuthCtx {
  return {
    query: qc as never,
    chain: {} as never,
    fetch: wire.fetch,
    logger: noopLogger,
    providerAuth: {
      providerToken: (i: { address: string; leaseUuid: string }) =>
        getAuthToken(i.address, i.leaseUuid),
      leaseDataToken: vi.fn(),
    },
  };
}

/** The recorded request whose path ends in `suffix` — the two reads race, so never index. */
function callTo(suffix: string) {
  return wire.calls.find((c) => new URL(c.url).pathname.endsWith(suffix));
}

const run = (ctx: FredAuthCtx) =>
  appStatus(ctx, { address: ADDR, leaseUuid: LEASE_UUID });

describe('appStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthToken.mockResolvedValue('auth-token');
    routeWire();
  });

  it('returns combined chain state and provider status for active lease', async () => {
    const result = await run(makeCtx(makeQc()));

    expect(result.lease_uuid).toBe(LEASE_UUID);
    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.fredStatus?.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.connection?.host).toBe('app.example.com');
  });

  it('queries provider status (but NOT connection) for a closed lease (ENG-600)', async () => {
    routeWire({ state: 'LEASE_STATE_CLOSED' });

    const result = await run(makeCtx(makeQc(LeaseState.LEASE_STATE_CLOSED)));

    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(result.fredStatus).toBeDefined();
    // Connection is meaningless for a non-running lease — never requested. `/connection` IS
    // routed, so this counts requests rather than depending on a refusal.
    expect(callTo('/status')).toBeDefined();
    expect(callTo('/connection')).toBeUndefined();
    expect(result.connection).toBeUndefined();
  });

  it('surfaces sanitized retention fields for a retained closed lease and omits partition (ENG-600)', async () => {
    routeWire({
      state: 'LEASE_STATE_CLOSED',
      provision_status: 'retained',
      retained_until: '2026-08-01T00:00:00Z',
      // Control char in sku proves the sanitize spread is WIRED (not clean-string pass-through).
      items: [{ sku: `s1${BIDI}`, quantity: 1 }],
      restore_hint: `restore${BIDI}me`,
      partition: 'p',
    });

    const result = await run(makeCtx(makeQc(LeaseState.LEASE_STATE_CLOSED)));

    expect(result.fredStatus?.retained_until).toBe('2026-08-01T00:00:00Z');
    expect(result.fredStatus?.restore_hint).toBe('restore me');
    expect(result.fredStatus?.items?.[0]?.sku).toBe('s1');
    // Decision 6: partition is omitted from the AI-facing projection.
    expect(result.fredStatus?.partition).toBeUndefined();
  });

  it('DROPS a malformed/injected retained_until instead of leaking it raw past the sanitizer (ENG-555)', async () => {
    routeWire({
      state: 'LEASE_STATE_CLOSED',
      provision_status: 'retained',
      // Non-RFC3339 + bidi-override payload: sanitizeRetentionFields omits it, so the raw
      // value must NOT survive via the `...rest` spread.
      retained_until: `not-a-timestamp${BIDI}evil`,
      partition: 'p',
    });

    const result = await run(makeCtx(makeQc(LeaseState.LEASE_STATE_CLOSED)));

    expect(result.fredStatus?.retained_until).toBeUndefined();
    expect(JSON.stringify(result.fredStatus)).not.toContain(BIDI);
  });

  it('surfaces the post-ENG-508 failure pair on fredStatus (ENG-638)', async () => {
    // A `ready` lease carrying a rolled-back UpdateFailed: Fred deliberately retains the
    // attribution on a HEALTHY lease, so this doubles as the case documenting that a
    // non-empty `reason` does not mean the app is down.
    routeWire({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'ready',
      reason: 'UpdateFailed',
      message: 'update failed; rolled back to the previous version',
    });

    const result = await run(makeCtx(makeQc()));

    expect(result.fredStatus?.provision_status).toBe('ready');
    expect(result.fredStatus?.reason).toBe('UpdateFailed');
    expect(result.fredStatus?.message).toBe(
      'update failed; rolled back to the previous version',
    );
  });

  it('SANITIZES provider failure text instead of leaking it raw past the spread (ENG-638)', async () => {
    // fredStatus is a looseObject, so any raw key left in `...rest` reaches model context
    // unsanitized. This is the guard that fails if someone drops reason/message/last_error
    // from the destructure-strip in appStatus.ts — now proven against text that arrived as
    // real JSON over the real transport.
    routeWire({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'failed',
      reason: `Container${BIDI}Exited`,
      message: `crash${BIDI}loop`,
    });

    const result = await run(makeCtx(makeQc()));

    expect(result.fredStatus?.message).toBe('crash loop');
    expect(JSON.stringify(result.fredStatus)).not.toContain(BIDI);
  });

  it('surfaces a pre-ENG-508 last_error on the canonical message key (ENG-638)', async () => {
    routeWire({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'failed',
      last_error: 'OOMKilled',
    });

    const result = await run(makeCtx(makeQc()));

    expect(result.fredStatus?.last_error).toBe('OOMKilled');
    expect(result.fredStatus?.message).toBe('OOMKilled');
  });

  it('includes lease.items in chainState (so consumers skip a second getLease)', async () => {
    const items = [
      {
        skuUuid: 'sku-1',
        quantity: 1n,
        lockedPrice: { denom: 'upwr', amount: '100' },
        serviceName: 'web',
        customDomain: 'app.example.com',
      },
    ];

    const result = await run(
      makeCtx(makeQc(LeaseState.LEASE_STATE_ACTIVE, items)),
    );

    expect(result.chainState.items).toEqual(items);
  });

  it('returns chainState.items as [] when the lease has no items (never undefined)', async () => {
    routeWire({ state: 'LEASE_STATE_CLOSED' });

    const result = await run(makeCtx(makeQc(LeaseState.LEASE_STATE_CLOSED)));

    expect(result.chainState.items).toEqual([]);
  });

  it('throws when lease not found', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });

    await expect(run(makeCtx(qc))).rejects.toThrow('not found on chain');
    expect(wire.calls).toHaveLength(0);
  });

  it('returns providerError when the provider cannot be resolved', async () => {
    // No providerLookup entry → the real resolveProviderUrl wraps the lookup failure as
    // QUERY_FAILED, and appStatus degrades rather than throwing.
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await run(makeCtx(qc));

    expect(result.providerError).toContain('Could not resolve provider');
    expect(result.fredStatus).toBeUndefined();
    expect(wire.calls).toHaveLength(0);
  });

  it('re-throws infrastructure errors from provider resolution', async () => {
    const infraErr = new ManifestMCPError(
      ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      'rpc down',
    );
    expect(INFRASTRUCTURE_ERROR_CODES.has(infraErr.code)).toBe(true);
    const qc = makeQc();
    // resolveProviderUrl re-throws a ManifestMCPError unchanged, so an infra failure from the
    // chain query reaches appStatus with its identity intact — which is what it branches on.
    qc.liftedinit.sku.v1.provider = vi
      .fn()
      .mockRejectedValue(infraErr) as never;

    await expect(run(makeCtx(qc))).rejects.toBe(infraErr);
  });

  it('handles partial provider failure with Promise.allSettled', async () => {
    routeWire({ status: 503, text: 'status failed' }, CONNECTION);

    const result = await run(makeCtx(makeQc()));

    expect(result.providerError).toContain('status failed');
    expect(result.connection?.host).toBe('app.example.com');
  });

  it('returns providerError when getAuthToken fails', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('signing failed'));

    const result = await run(makeCtx(makeQc(), failing));

    expect(result.providerError).toContain('Auth token error');
    expect(result.fredStatus).toBeUndefined();
    expect(wire.calls).toHaveLength(0);
  });

  it('sends the status token to /status and the connection token to /connection', async () => {
    // The ENG-717 concern, and now a WIRE claim: which token reaches which endpoint. Read off
    // the recorded requests, matched by URL — the two reads race under allSettled, so an index
    // would be a coin flip.
    const distinctTokenFn = vi
      .fn()
      .mockResolvedValueOnce('status-token')
      .mockResolvedValueOnce('conn-token');

    await run(makeCtx(makeQc(), distinctTokenFn));

    expect(distinctTokenFn).toHaveBeenCalledTimes(2);
    const statusHeaders = callTo('/status')?.init.headers as
      | Record<string, string>
      | undefined;
    const connHeaders = callTo('/connection')?.init.headers as
      | Record<string, string>
      | undefined;
    expect(statusHeaders?.Authorization).toBe('Bearer status-token');
    expect(connHeaders?.Authorization).toBe('Bearer conn-token');
  });

  it('returns connectionError when only connection info fails', async () => {
    routeWire(undefined, { status: 500, text: 'connection failed' });

    const result = await run(makeCtx(makeQc()));

    expect(result.fredStatus?.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.connectionError).toContain('connection failed');
  });
});
