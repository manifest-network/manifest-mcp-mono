import { toHex } from '@cosmjs/encoding';
import {
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  const sealed = (name: string) =>
    vi.fn(() => {
      throw new Error(
        `core.${name}() is sealed in this test file (ENG-713). Nothing here called it when the ` +
          'seal was written; if the code under test needs it now, replace the seal with an ' +
          'explicit spy and assert on it. Do NOT simply drop it.',
      );
    });
  return {
    ...actual,
    cosmosTx: vi.fn(),
    // Closed over core's whole BROADCAST surface, not just the `cosmosTx` this file asserts on.
    // These four never reach the `cosmosTx` spy above: the three tx helpers call it through their
    // own module-local `'../cosmos.js'` import, and `executeTx` broadcasts straight off
    // `ctx.chain`. Vitest does not rewrite intra-module references, so a mock of this BARREL
    // cannot intercept any of them — measured: the spy recorded 0 calls while the real `cosmosTx`
    // threw from inside. The `makeSealedClientManager` chain in `makeCtx()` below is what actually
    // CONTAINS them; these stubs only buy a first-line message that names the helper (ENG-713).
    setItemCustomDomain: sealed('setItemCustomDomain'),
    stopApp: sealed('stopApp'),
    fundCredits: sealed('fundCredits'),
    executeTx: sealed('executeTx'),
    cosmosEstimateFee: sealed('cosmosEstimateFee'),
  };
});
// ENG-725: `../http/fred.js` is NO LONGER mocked. The provider wire is injected at `ctx.fetch` as
// a sealed probe, so the real `getLeaseProvision` / `restoreLease` / `pollLeaseUntilReady`, the
// real `fetchJsonChecked` and the real `classifyTransportError` all run. That matters here more
// than anywhere: every saga branch below is selected by the SHAPE of a `ProviderApiError`, and
// those errors are now BUILT by the transport from a wire response rather than hand-constructed by
// the test. A test that says "422 means cancel-and-reject" now proves the transport turns a 422
// response into that verdict, not merely that the tool branches on a value it was handed.
//
// Still mocked, deliberately and out of ENG-725's scope: the CORE BARREL (the chain-broadcast seam
// — ENG-713, sealed via `makeSealedClientManager` below), and the chain-side tool modules
// `createLease` / `fetchLease` / `resolveLeaseProvider`. This file's `ctx.query` is `{}` on
// purpose; it is about the broadcast seam, not the read path.
vi.mock('./createLease.js', () => ({ createLease: vi.fn() }));
vi.mock('./fetchLease.js', () => ({ fetchLease: vi.fn() }));
vi.mock('./resolveLeaseProvider.js', () => ({ resolveProviderUrl: vi.fn() }));

import { cosmosTx } from '@manifest-network/manifest-mcp-core';
import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { makeSealedClientManager } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { createLease } from './createLease.js';
import { fetchLease } from './fetchLease.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { restoreApp } from './restoreApp.js';

const mockCosmosTx = vi.mocked(cosmosTx);
const mockCreateLease = vi.mocked(createLease);
const mockFetchLease = vi.mocked(fetchLease);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const SOURCE = '11111111-2222-3333-4444-555555555555';
const NEW = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const META = new Uint8Array([1, 2]);
const PROVIDER_URL = 'https://provider.example.com';

/** The three provider endpoints a restore touches, in saga order. */
type RestoreRoutes = {
  provision?: unknown;
  restore?: unknown;
  status?: unknown;
};

// Initialized eagerly: the ENG-713 containment describe below builds a ctx outside restoreApp's
// beforeEach, so `wire` must already exist. It routes nothing there and dispatches nothing.
let wire: ReturnType<typeof sealedFetchProbe> = sealedFetchProbe();

/**
 * Route the restore saga's wire. A value that is already a probe STEP (or a per-call function
 * returning one) is used as-is; anything else is sent as a 2xx JSON body.
 *
 * NOTE the numeric-`status` test. Sniffing for a `status` KEY does not work here: Fred's
 * `/provision` body legitimately carries `status: 'retained'`, so a key-only check turns a
 * perfectly good response body into `new Response(…, { status: 'retained' })` and the transport
 * reports an opaque `init["status"] must be in the range of 200 to 599`. An HTTP status is a
 * number; a provider status is a string. Discriminate on the type, not the key.
 */
function routeWire(r: RestoreRoutes = {}): void {
  const isStep = (v: unknown): boolean =>
    typeof v === 'object' &&
    v !== null &&
    ('json' in v ||
      'transportError' in v ||
      'streamError' in v ||
      'hang' in v ||
      typeof (v as { status?: unknown }).status === 'number');
  const step = (v: unknown, fallback: unknown) => {
    const chosen = v ?? fallback;
    if (typeof chosen === 'function') return chosen as never; // per-call script
    return (isStep(chosen) ? chosen : { json: chosen }) as never;
  };
  wire = sealedFetchProbe({
    '/provision': step(r.provision, { status: 'retained', fail_count: 0 }),
    '/restore': step(r.restore, { status: 'provisioning' }),
    '/status': step(r.status, {
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'ready',
    }),
  });
}

/** Requests the probe saw, by last path segment. */
function urls(): string[] {
  return wire.calls.map((c) => new URL(c.url).pathname.split('/').pop() ?? '');
}

function makeCtx() {
  return {
    // Sealed: every CosmosClientManager method throws by name except the one this file asserts on.
    // This is the seam every core broadcast must pass through — `cosmosTx(clientManager, ...)` and
    // `executeTx(ctx)` alike — so it contains the internal `'../cosmos.js'` edge that the barrel
    // mock above provably cannot reach, and it keeps working when core gains a new helper (ENG-713).
    chain: makeSealedClientManager({
      acquireRateLimit: vi.fn().mockResolvedValue(undefined),
    }) as never,
    query: {} as never,
    // The sealed provider wire. Unlike the chain seam above, this one is EXERCISED: the real
    // transport dispatches through it, and an endpoint no test routed fails by name (ENG-725).
    fetch: wire.fetch as never,
    allowLoopback: false,
    providerAuth: {
      providerToken: vi.fn().mockResolvedValue('tok'),
      leaseDataToken: vi.fn(),
    },
  } as unknown as Parameters<typeof restoreApp>[0];
}

function mockSource(items: unknown[] = [{ skuUuid: 's1', quantity: 1n }]) {
  mockFetchLease.mockResolvedValue({
    uuid: SOURCE,
    state: LeaseState.LEASE_STATE_CLOSED,
    providerUuid: 'prov-1',
    metaHash: META,
    items,
  } as never);
}

/**
 * The seal's own guard. `packages/core/src/__test-utils__/sealed-chain.test.ts` proves that
 * `makeSealedClientManager` CONTAINS a real core broadcaster; it cannot prove the seal is INSTALLED
 * here. This does, and it is the only test in this file that exercises the un-interceptable edge:
 * `vi.importActual` bypasses the barrel mock above, so `setItemCustomDomain` arrives real, with its
 * real module-local `import { cosmosTx } from '../cosmos.js'` — exactly the shape a future
 * custom-domain restore would take (`restoreApp.ts` only reports `custom_domain_not_restored` today).
 *
 * Reverting `makeCtx().chain` to a bare `{ acquireRateLimit }` literal makes this fail with an
 * unclassified `TypeError: clientManager.getConfig is not a function` instead — which is precisely
 * the pre-ENG-713 behaviour, and why this test is worth its ten lines.
 */
describe('core broadcast containment (ENG-713)', () => {
  it('a REAL core tx helper driven with this file ctx.chain fails by name', async () => {
    const {
      setItemCustomDomain: realSetItemCustomDomain,
      asFqdn,
      asLeaseUuid,
    } = await vi.importActual<
      typeof import('@manifest-network/manifest-mcp-core')
    >('@manifest-network/manifest-mcp-core');

    const err = await realSetItemCustomDomain(
      { chain: makeCtx().chain } as never,
      {
        leaseUuid: asLeaseUuid(NEW),
        customDomain: asFqdn('app.example.com'),
      },
    ).then(
      () => new Error('NO THROW — the sealed chain was never reached'),
      (e: unknown) => e as Error,
    );

    expect(err.message).toContain('is sealed in this test (ENG-713)');
  });
});

describe('restoreApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeWire();
    mockResolveProviderUrl.mockResolvedValue(PROVIDER_URL);
    mockCreateLease.mockResolvedValue(NEW as never);
    // clearAllMocks() resets calls but NOT implementations, so a mockRejectedValue
    // set by one case would otherwise leak into every later one.
    mockCosmosTx.mockResolvedValue(undefined as never);
  });

  it('happy path: creates a fresh lease from the source and restores onto it', async () => {
    mockSource();
    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    );

    expect(result).toEqual({
      lease_uuid: NEW,
      source_lease_uuid: SOURCE,
      status: 'provisioning',
    });
    expect(mockCreateLease).toHaveBeenCalledWith(expect.anything(), {
      metaHashHex: toHex(META),
      leaseItems: ['s1:1'],
    });
    // The saga's wire, in order, read off the requests the provider actually received. The
    // POST goes to the NEW lease and names the SOURCE lease in its body — a swap that the old
    // argument-slot assertion could state but not prove reached the wire that way.
    expect(urls()).toEqual(['provision', 'restore']);
    const post = wire.calls[1]!;
    expect(post.url).toBe(`${PROVIDER_URL}/v1/leases/${NEW}/restore`);
    expect(post.init.method).toBe('POST');
    expect(JSON.parse(String(post.init.body))).toEqual({
      from_lease_uuid: SOURCE,
    });
    expect((post.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
    // The pre-flight read is scoped to the SOURCE lease, not the new one.
    expect(wire.calls[0]?.url).toBe(
      `${PROVIDER_URL}/v1/leases/${SOURCE}/provision`,
    );
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('pre-flight: throws RESTORE_NOT_RETAINED without creating a lease when source is not retained', async () => {
    mockSource();
    routeWire({ provision: { status: 'active', fail_count: 0 } });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RESTORE_NOT_RETAINED,
    });
    expect(mockCreateLease).not.toHaveBeenCalled();
  });

  it('terminal 422: cancels the created lease once and throws RESTORE_REJECTED', async () => {
    mockSource();
    routeWire({ restore: { status: 422, text: 'demote' } });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.RESTORE_REJECTED });
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
  });

  it('503: cancels and throws RESTORE_RETRYABLE (agent may re-invoke)', async () => {
    mockSource();
    routeWire({ restore: { status: 503, text: 'insufficient resources' } });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.RESTORE_RETRYABLE });
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
  });

  // Fred ENG-620/ENG-739 added a tenant-facing 502 to POST /restore: providerd now
  // AUTHORS the error when a backend's 4xx body is off-contract, instead of relaying
  // it as a 400/404. These two cases pin the deliberate asymmetry in how mono answers.
  it('429 (throttled before the handler ran): cancels and throws RESTORE_RETRYABLE', async () => {
    mockSource();
    // Fred's TenantRateLimiter rejects inside AuthMiddleware, so the restore handler
    // never executes and nothing can have been adopted — provably uncommitted, exactly
    // like the 401 from that same middleware which is already treated as terminal.
    routeWire({ restore: { status: 429, text: 'rate limit exceeded' } });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.RESTORE_RETRYABLE });
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
  });

  it('429 with Retry-After: the wait the provider asked for reaches the caller', async () => {
    mockSource();
    routeWire({
      restore: {
        status: 429,
        text: 'rate limit exceeded',
        headers: { 'retry-after': '30' },
      },
    });
    const err = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    ).catch((e: unknown) => e);
    // A throttle is only actionable with a delay attached; the transport already
    // parses Retry-After into ProviderApiError.retryAfterMs, so not surfacing it
    // would throw the one useful fact away.
    expect((err as Error).message).toMatch(/30\s*s|30000\s*ms/i);
  });

  // DELIBERATE, and the inverse of the 429 above — do not "fix" this into a cancel.
  // Fred's OWN 502 means the request was not applied, so cancelling would be correct
  // for it. But mono cannot distinguish that from a 502 minted by a reverse proxy
  // sitting IN FRONT of Fred, where the POST may well have reached Fred and been
  // adopted. Cancelling there would cancel-lease a restore that committed and destroy
  // the adopted data — the same hazard the 2xx-parse-failure branch already guards.
  // Leaving 502 in-doubt costs an orphaned PENDING lease, which is recoverable; the
  // other way round is not.
  it('502: does NOT cancel — stays in-doubt and surfaces the orphan for manual rollback', async () => {
    mockSource();
    routeWire({
      restore: {
        status: 502,
        text: 'the provider backend returned an unusable error; the request was not applied',
      },
    });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
      details: { orphaned_lease_uuid: NEW },
    });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('in-doubt (status 0 timeout): does NOT cancel; throws RESTORE_ORPHAN with the orphaned uuid', async () => {
    mockSource();
    // A transport-level failure (no HTTP response): classifyTransportError tags it
    // `kind:'network'` with status 0, which is the in-doubt shape the saga must not cancel on.
    routeWire({ restore: { transportError: new Error('timeout') } });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
      details: { orphaned_lease_uuid: NEW },
    });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('compensation fails: 422 + cancel rejects → RESTORE_ORPHAN naming the orphaned uuid', async () => {
    mockSource();
    routeWire({ restore: { status: 422, text: 'demote' } });
    mockCosmosTx.mockRejectedValue(new Error('chain unreachable'));
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
      details: { orphaned_lease_uuid: NEW },
    });
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
  });

  it('post-pivot poll timeout: reports provisioning and does NOT cancel (data-loss guard)', async () => {
    mockSource();
    // The provider stays unreachable. Driving the REAL poll means the deadline has to be real
    // too — a transport fault is retryable by design, so the loop tolerates it until `timeoutMs`
    // rather than giving up on the first rejection the way the old mock did.
    routeWire({ status: { transportError: new Error('poll timeout') } });

    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: { intervalMs: 0, timeoutMs: 25 } },
    );

    // The volumes are already pivoted onto the new lease, so a poll that never confirms must
    // still report success-in-progress and must NOT cancel — cancelling would destroy them.
    expect(result).toMatchObject({ lease_uuid: NEW, status: 'provisioning' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
    expect(urls()).toContain('status');
  });

  it('post-pivot provider failure verdict rejects with its detail and does NOT cancel', async () => {
    mockSource([
      {
        skuUuid: 's1',
        quantity: 1n,
        customDomain: 'app.x.com',
      },
    ]);
    routeWire({
      status: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'failed',
        reason: 'ImagePullFailed',
        message: 'registry denied the image',
      },
    });

    const err = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: { intervalMs: 0, timeoutMs: 25 } },
    ).catch((caught: unknown) => caught);

    expect(err).toMatchObject({
      code: ManifestMCPErrorCode.RESTORE_COMMITTED_FAILURE,
      details: {
        lease_uuid: NEW,
        source_lease_uuid: SOURCE,
        committed: true,
        restore_status: 'provisioning',
        custom_domain_not_restored: ['app.x.com'],
      },
    });
    expect((err as Error).message).toContain('registry denied the image');
    // The restore already committed and adopted the volumes. Even a reported
    // provisioning failure must never enter the pre-pivot compensation path.
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('post-pivot poll SUCCESS: returns the polled ready status', async () => {
    mockSource();
    routeWire({
      status: { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' },
    });

    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: { intervalMs: 0 } },
    );

    expect(result.lease_uuid).toBe(NEW);
    // `ready` is the only status PROVISION_SUCCESS admits; the old fixture said 'running',
    // which the real classifier would have kept polling on (ENG-651's fail-closed default).
    expect(result.ready).toMatchObject({ provision_status: 'ready' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('committed-but-empty-body (2xx ProviderApiError): treated as committed, NOT orphaned', async () => {
    mockSource();
    // An empty body on a 2xx: the real parse throws a ProviderApiError carrying the 2xx
    // status, which the saga must read as COMMITTED rather than orphaned.
    routeWire({ restore: { status: 202, text: '' } });
    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    );
    expect(result).toMatchObject({ lease_uuid: NEW, status: 'provisioning' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('surfaces custom_domain_not_restored when the source items carry a custom domain', async () => {
    mockSource([
      {
        skuUuid: 's1',
        quantity: 1n,
        serviceName: 'web',
        customDomain: 'app.x.com',
      },
    ]);
    const result = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    );
    expect(result.custom_domain_not_restored).toEqual(['app.x.com']);
  });

  it('acquires the rate limit once before the pre-tx reads (Copilot #2)', async () => {
    mockSource();
    const ctx = makeCtx();
    await restoreApp(
      ctx,
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false },
    );
    expect(
      (
        ctx as unknown as {
          chain: { acquireRateLimit: ReturnType<typeof vi.fn> };
        }
      ).chain.acquireRateLimit,
    ).toHaveBeenCalledTimes(1);
  });

  it('sanitizes provider-controlled text out of the failure message (Copilot #1)', async () => {
    mockSource();
    const bidi = String.fromCharCode(0x202e);
    routeWire({ restore: { status: 422, text: `demote${bidi}evil` } });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Error && !e.message.includes(bidi),
    );
  });

  it('aborts before createLease when the signal fires during pre-flight reads — no broadcast, no orphan (ENG-488)', async () => {
    mockSource();
    const ac = new AbortController();
    // Abort lands during the pre-flight provision read — before createLease.
    routeWire({
      provision: () => {
        ac.abort();
        return { json: { status: 'retained', fail_count: 0 } };
      },
    });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false, signal: ac.signal },
      ),
    ).rejects.toSatisfy((e: unknown) => (e as Error)?.name === 'AbortError');
    // The on-chain create-lease broadcast must NOT fire after an abort.
    expect(mockCreateLease).not.toHaveBeenCalled();
  });

  it('rolls the fresh lease back when the signal fires between createLease and the restore POST (ENG-666)', async () => {
    mockSource();
    const ac = new AbortController();
    // Abort lands right after the lease is created, before the restore POST.
    mockCreateLease.mockImplementation(async () => {
      ac.abort();
      return NEW as never;
    });
    const err = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false, signal: ac.signal },
    ).catch((e: unknown) => e);

    // The restore POST never fired — nothing was adopted (unchanged from ENG-488).
    expect(urls()).not.toContain('restore');
    // ...so the empty PENDING shell is rolled back rather than left reserving credit.
    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
    // A bare AbortError would name no lease, and over MCP the host never sees the
    // rejection at all — so the outcome has to be a reported, identified rollback.
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect((err as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.OPERATION_CANCELLED,
    );
    expect((err as ManifestMCPError).details).toMatchObject({
      lease_uuid: NEW,
      rolled_back: true,
    });
  });

  it('rolls back when the cancel lands during the token mint, the one await before the POST (ENG-666)', async () => {
    mockSource();
    const ac = new AbortController();
    const ctx = makeCtx();
    // Two tokens are minted: the SOURCE one during pre-flight, then the NEW-lease one
    // just before the POST. Only the latter sits in the window under test — aborting
    // on the former would trip the earlier pre-broadcast guard instead.
    (
      ctx.providerAuth.providerToken as ReturnType<typeof vi.fn>
    ).mockImplementation(async ({ leaseUuid }: { leaseUuid: string }) => {
      if (leaseUuid === NEW) ac.abort();
      return 'tok';
    });

    const err = await restoreApp(
      ctx,
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false, signal: ac.signal },
    ).catch((e: unknown) => e);

    expect(urls()).not.toContain('restore');
    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
    expect((err as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.OPERATION_CANCELLED,
    );
  });

  it('falls back to the orphan surface when the compensating cancel itself fails (ENG-666)', async () => {
    mockSource();
    const ac = new AbortController();
    mockCreateLease.mockImplementation(async () => {
      ac.abort();
      return NEW as never;
    });
    mockCosmosTx.mockRejectedValue(new Error('chain unreachable'));

    const err = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false, signal: ac.signal },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ManifestMCPError);
    expect((err as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
    );
    expect((err as ManifestMCPError).details).toMatchObject({
      orphaned_lease_uuid: NEW,
    });
  });

  it('still compensates and reports the provider verdict when a rejection coincides with an abort (ENG-666)', async () => {
    // Guards the removal of the `if (aborted) throw err` bypass: a real 422 that
    // merely coincides with a cancel must still be classified by the PROVIDER's
    // answer — not short-circuited into a bare abort that skips the rollback.
    mockSource();
    const ac = new AbortController();
    routeWire({
      restore: () => {
        ac.abort();
        return { status: 422, text: 'unprocessable' };
      },
    });

    const err = await restoreApp(
      makeCtx(),
      { address: 'a', sourceLeaseUuid: SOURCE },
      { pollOptions: false, signal: ac.signal },
    ).catch((e: unknown) => e);

    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'cancel-lease',
      [NEW],
      true,
    );
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect((err as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.RESTORE_REJECTED,
    );
  });

  it('honours the deprecated abortSignal spelling as well as signal (ENG-666)', async () => {
    mockSource();
    const ac = new AbortController();
    routeWire({
      provision: () => {
        ac.abort();
        return { json: { status: 'retained', fail_count: 0 } };
      },
    });
    await expect(
      restoreApp(
        makeCtx(),
        { address: 'a', sourceLeaseUuid: SOURCE },
        { pollOptions: false, abortSignal: ac.signal },
      ),
    ).rejects.toSatisfy((e: unknown) => (e as Error)?.name === 'AbortError');
    expect(mockCreateLease).not.toHaveBeenCalled();
  });
});
