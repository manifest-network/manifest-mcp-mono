// This file mocks NOTHING (ENG-725). The wire is injected at `ctx.fetch` as a sealed probe, so the
// real provider lookup, SSRF check, update POST, readiness poll and transport all run.
//
// The manifest-merge cases are the interesting half. They used to read the merged bytes straight
// off `updateLease`'s argument list; they now decode them from the REQUEST BODY, which is where a
// provider actually receives them — base64 inside JSON, per `updateLease`'s wire contract. So the
// merge assertions additionally prove the encoding, which nothing covered before.
import { fromBase64 } from '@cosmjs/encoding';
import {
  LeaseState,
  ManifestMCPErrorCode,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FredAuthCtx } from '../ctx.js';
import { updateApp } from './updateApp.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const PROVIDER_URL = 'https://provider.example.com';
const ADDR = 'manifest1abc';

const READY = { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' };
const PENDING = { state: 'LEASE_STATE_PENDING' };

const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

let wire: ReturnType<typeof sealedFetchProbe>;

/** Route the two endpoints an update touches. `status` may be a script, so a poll can iterate. */
function routeWire(status: unknown = READY): void {
  wire = sealedFetchProbe({
    '/update': { json: { status: 'updated' } },
    '/status': (Array.isArray(status)
      ? status.map((s) => ({ json: s }))
      : { json: status }) as never,
  });
}

/** Requests the probe saw, by last path segment. */
function urls(): string[] {
  return wire.calls.map((c) => new URL(c.url).pathname.split('/').pop() ?? '');
}

/**
 * The manifest bytes as the PROVIDER received them: decoded out of the `/update` request body.
 * `updateLease` sends `{ payload: <base64> }` because the Go field is a `[]byte`.
 */
function sentBytes(): Uint8Array {
  const call = wire.calls.find((c) => c.url.endsWith('/update'));
  if (!call) throw new Error('no /update request was made');
  const body = JSON.parse(String(call.init.body)) as { payload: string };
  return fromBase64(body.payload);
}

/** One service inside a stack manifest, as the merge produces it. */
interface MergedService {
  image?: string;
  env?: Record<string, string>;
  ports?: Record<string, unknown>;
}

/** A merged manifest: either a single service, or a `services` stack. */
interface MergedManifest extends MergedService {
  user?: string;
  services?: Record<string, MergedService>;
}

/** The decoded `/update` payload, parsed as JSON. */
function sentManifest(): MergedManifest {
  return JSON.parse(new TextDecoder().decode(sentBytes())) as MergedManifest;
}

function activeQc() {
  return makeMockQueryClient({
    billing: {
      lease: {
        uuid: LEASE_UUID,
        state: LeaseState.LEASE_STATE_ACTIVE,
        providerUuid: 'prov-1',
      },
    },
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

describe('updateApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthToken.mockResolvedValue('auth-token');
    routeWire();
  });

  it('without existingManifest: full replacement', async () => {
    const qc = activeQc();

    const manifest = JSON.stringify({
      image: 'nginx:2',
      ports: { '80/tcp': {} },
    });
    await updateApp(
      makeCtx(qc),
      {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest,
      },
      { pollOptions: false },
    );

    // Should pass manifest through unchanged (encoded as Uint8Array)
    const rawPayload = sentBytes();
    expect(rawPayload).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(rawPayload)).toBe(manifest);
  });

  it('with existingManifest: env merged, ports merged, fields carried forward', async () => {
    const qc = activeQc();

    const newManifest = JSON.stringify({
      image: 'nginx:2',
      env: { NEW: 'val' },
    });
    const existingManifest = JSON.stringify({
      image: 'nginx:1',
      ports: { '80/tcp': {} },
      env: { OLD: 'kept', NEW: 'overridden' },
      user: '1000:1000',
    });

    await updateApp(
      makeCtx(qc),
      {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest,
      },
      { pollOptions: false },
    );

    const sent = sentManifest();
    expect(sent.image).toBe('nginx:2');
    expect(sent.env).toEqual({ OLD: 'kept', NEW: 'val' });
    expect(sent.ports).toEqual({ '80/tcp': {} });
    expect(sent.user).toBe('1000:1000');
  });

  it('stack merge: per-service env merged with services wrapper in output', async () => {
    const qc = activeQc();

    const newManifest = JSON.stringify({
      services: {
        web: { image: 'nginx:2', env: { NEW: 'val' } },
        db: { image: 'mysql:9' },
      },
    });
    const existingManifest = JSON.stringify({
      services: {
        web: {
          image: 'nginx:1',
          env: { OLD: 'kept', NEW: 'overridden' },
          ports: { '80/tcp': {} },
        },
        db: { image: 'mysql:8', ports: { '3306/tcp': {} } },
      },
    });

    await updateApp(
      makeCtx(qc),
      {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest,
      },
      { pollOptions: false },
    );

    const sent = sentManifest();
    expect(sent.services).toBeDefined();
    expect(sent.services?.web?.image).toBe('nginx:2');
    expect(sent.services?.web?.env).toEqual({ OLD: 'kept', NEW: 'val' });
    expect(sent.services?.web?.ports).toEqual({ '80/tcp': {} });
    expect(sent.services?.db?.image).toBe('mysql:9');
    expect(sent.services?.db?.ports).toEqual({ '3306/tcp': {} });
  });

  it('stack merge: new service gets empty merge base', async () => {
    const qc = activeQc();

    const newManifest = JSON.stringify({
      services: {
        web: { image: 'nginx' },
        cache: { image: 'redis', env: { MAXMEM: '64mb' } },
      },
    });
    const existingManifest = JSON.stringify({
      services: {
        web: { image: 'nginx', env: { OLD: 'val' } },
      },
    });

    await updateApp(
      makeCtx(qc),
      {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest,
      },
      { pollOptions: false },
    );

    const sent = sentManifest();
    expect(sent.services?.cache?.image).toBe('redis');
    expect(sent.services?.cache?.env).toEqual({ MAXMEM: '64mb' });
  });

  it('throws on invalid manifest JSON when existingManifest is provided', async () => {
    const qc = activeQc();

    await expect(
      updateApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: 'not-valid-json',
        existingManifest: '{"image":"nginx"}',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid manifest JSON'),
    });
  });

  it('stack merge: throws on unparseable existingManifest JSON', async () => {
    const qc = activeQc();

    const newManifest = JSON.stringify({
      services: { web: { image: 'nginx' } },
    });

    await expect(
      updateApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest: 'not-valid-json',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid existing_manifest'),
    });
  });

  it('stack merge: throws on invalid service name', async () => {
    const qc = activeQc();

    const newManifest = JSON.stringify({
      services: { 'INVALID_NAME!': { image: 'nginx' } },
    });

    await expect(
      updateApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest: '{"services":{"web":{"image":"old"}}}',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid service name'),
    });
  });

  it('stack merge: throws when existing_manifest is not a stack', async () => {
    const qc = activeQc();

    const newManifest = JSON.stringify({
      services: { web: { image: 'nginx' } },
    });
    const existingManifest = JSON.stringify({
      image: 'nginx',
      ports: { '80/tcp': {} },
    });

    await expect(
      updateApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
        manifest: newManifest,
        existingManifest,
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Cannot merge'),
    });
  });

  // ── ENG-488 lifecycle options (fast-path + default-poll) ──

  it('default: resolves lease + provider, updates, then polls to ready', async () => {
    const result = await updateApp(makeCtx(activeQc()), {
      address: ADDR,
      leaseUuid: LEASE_UUID,
      manifest: '{"image":"nginx","ports":{}}',
    });

    expect(urls()).toEqual(['update', 'status']);
    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/update`,
    );
    expect(wire.calls[0]?.init.method).toBe('POST');
    expect(result).toEqual({
      lease_uuid: LEASE_UUID,
      status: 'updated',
      ready: {
        state: LeaseState.LEASE_STATE_ACTIVE,
        provision_status: 'ready',
      },
    });
  });

  it('pollOptions:false → fire-and-return, no /status request, no ready field', async () => {
    const result = await updateApp(
      makeCtx(activeQc()),
      {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","ports":{}}',
      },
      { pollOptions: false },
    );

    // `/status` IS routed, so this counts requests rather than relying on a refusal.
    expect(urls()).toEqual(['update']);
    expect(result).toEqual({ lease_uuid: LEASE_UUID, status: 'updated' });
  });

  it('fast path: supplied providerUrl skips fetchActiveLease + resolveProviderUrl', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    const leaseFn = qc.liftedinit.billing.v1.lease;
    await updateApp(
      makeCtx(qc),
      {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","ports":{}}',
      },
      { providerUrl: PROVIDER_URL },
    );

    expect(leaseFn).not.toHaveBeenCalled(); // fetchActiveLease not run
    expect(qc.liftedinit.sku.v1.provider).not.toHaveBeenCalled();
    // Both legs went to the SUPPLIED url, carrying the minted token — read off the wire,
    // so no signature change can slide these onto a different argument.
    expect(urls()).toEqual(['update', 'status']);
    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${LEASE_UUID}/update`,
    );
    const headers = wire.calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer auth-token');
    expect(sentBytes()).toBeInstanceOf(Uint8Array);
  });

  it('fast path WITH existingManifest: merge still runs and zero chain queries', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    const leaseFn = qc.liftedinit.billing.v1.lease;
    await updateApp(
      makeCtx(qc),
      {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","env":{"A":"1"}}',
        existingManifest: '{"image":"old","env":{"B":"2"}}',
      },
      { providerUrl: PROVIDER_URL },
    );

    expect(leaseFn).not.toHaveBeenCalled();
    expect(qc.liftedinit.sku.v1.provider).not.toHaveBeenCalled();
    expect(sentManifest().env).toEqual({ A: '1', B: '2' });
  });

  it('re-mints the auth token on every poll iteration', async () => {
    // Was "the poll received a token FUNCTION" — a shape assertion that would pass just as
    // happily on a function called once and cached, which is the ADR-036 replay bug it exists
    // to prevent. Counted instead: 1 mint for the POST plus 1 per poll read.
    routeWire([PENDING, PENDING, READY]);

    await updateApp(
      makeCtx(activeQc()),
      {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","ports":{}}',
      },
      { pollOptions: { intervalMs: 0 } },
    );

    expect(urls()).toEqual(['update', 'status', 'status', 'status']);
    expect(mockGetAuthToken).toHaveBeenCalledTimes(4);
    expect(mockGetAuthToken).toHaveBeenLastCalledWith(ADDR, LEASE_UUID);
  });

  it('pre-aborted signal → throws before the mutate POST', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      updateApp(
        makeCtx(activeQc()),
        {
          address: ADDR,
          leaseUuid: LEASE_UUID,
          manifest: '{"image":"nginx","ports":{}}',
        },
        { abortSignal: ac.signal },
      ),
    ).rejects.toThrow();
    // Nothing reached the provider at all — exact, because the probe records every request.
    expect(wire.calls).toHaveLength(0);
  });

  it('abort DURING providerUrl resolution → the mutate POST is not fired', async () => {
    const ac = new AbortController();
    const qc = activeQc();
    // Abort from inside the on-chain provider lookup: after updateApp's top guard, before the
    // pre-POST fence. Wrapping the query keeps the exact window the old resolveProviderUrl mock
    // targeted, without mocking the tool module.
    const realProvider = qc.liftedinit.sku.v1.provider;
    qc.liftedinit.sku.v1.provider = vi.fn(async (req: { uuid: string }) => {
      ac.abort();
      return realProvider(req);
    }) as never;

    await expect(
      updateApp(
        makeCtx(qc),
        {
          address: ADDR,
          leaseUuid: LEASE_UUID,
          manifest: '{"image":"nginx","ports":{}}',
        },
        { abortSignal: ac.signal },
      ),
    ).rejects.toThrow();
    expect(wire.calls).toHaveLength(0);
  });

  it('default path throws when lease is not active', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
        },
      },
      sku: {
        providerLookup: { 'prov-1': { provider: { apiUrl: PROVIDER_URL } } },
      },
    });

    await expect(
      updateApp(makeCtx(qc), {
        address: ADDR,
        leaseUuid: LEASE_UUID,
        manifest: '{"image":"nginx","ports":{}}',
      }),
    ).rejects.toThrow('cannot be updated');
    expect(wire.calls).toHaveLength(0);
  });
});
