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
    // setItemCustomDomain calls cosmosTx through an internal `'../cosmos.js'` import that the
    // package-level mock above does NOT intercept — vitest does not rewrite intra-module
    // references. Mocking the helper directly is what closes that edge, and it also makes
    // deployManifest's orchestration call observable. (deployApp.test.ts carries the same pair.)
    setItemCustomDomain: vi.fn(),
    // The rest of core's broadcast surface, sealed for the same reason: `stopApp`/`fundCredits`
    // share that edge and `executeTx` broadcasts straight off `ctx.chain`, so none of them can
    // reach the `cosmosTx` spy above. Nothing on the deploy path calls them today — the seal makes
    // the day one does a named failure rather than the plausible-looking `TX_FAILED` this file's
    // permissive `makeMockClientManager` chain would otherwise produce (measured, ENG-713).
    stopApp: sealed('stopApp'),
    fundCredits: sealed('fundCredits'),
    executeTx: sealed('executeTx'),
    cosmosEstimateFee: sealed('cosmosEstimateFee'),
  };
});

import * as coreModule from '@manifest-network/manifest-mcp-core';
import {
  asFqdn,
  asLeaseUuid,
  asProviderUuid,
  asSkuUuid,
  cosmosTx,
  LeaseState,
  logger,
  ManifestMCPErrorCode,
  noopLogger,
  setItemCustomDomain,
} from '@manifest-network/manifest-mcp-core';
import { sealedFetchProbe } from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import {
  makeMockClientManager,
  makeMockQueryClient,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import type { FredAuthCtx } from '../ctx.js';
import { TerminalChainStateError } from '../http/fred.js';
import { ProviderApiError } from '../http/provider.js';
import { deployApp } from './deployApp.js';
import { deployManifest } from './deployManifest.js';

// ENG-725: `../http/provider.js` and `../http/fred.js` are NO LONGER mocked. The provider wire is
// injected at `ctx.fetch` as a sealed probe, so the real `uploadLeaseData`, `getLeaseConnectionInfo`
// and readiness poll run, along with `validateProviderUrl`, `fetchJsonChecked` and `checkedFetch`.
//
// That retires the ENG-715 `provider.js mock coverage` guard this file used to carry. Its job was
// to prove no WIRE export of `provider.ts` was left real inside a partial mock — a hazard that
// only exists while there IS a partial mock. Nothing here mocks that module now, so there is no
// classification to keep honest; the default-deny probe below replaces it, and it covers every
// endpoint rather than every export.
//
// The core-barrel mock ABOVE stays, and so does its `core broadcast-surface mock coverage` guard.
// That is the CHAIN seam (ENG-713) — a different escaping resource, untouched by any of this.

/** The three provider endpoints a deploy touches. */
type DeployRoutes = { data?: unknown; status?: unknown; connection?: unknown };

let wire: ReturnType<typeof sealedFetchProbe> = sealedFetchProbe();

const READY_STATUS = {
  state: 'LEASE_STATE_ACTIVE',
  provision_status: 'ready',
};
const CONNECTION_BODY = {
  lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
  tenant: 'manifest1tenant',
  provider_uuid: 'prov-1',
  connection: {
    host: 'app.localhost',
    ports: {
      '80/tcp': { host_ip: '0.0.0.0', host_port: 32001 },
    },
  },
};

/**
 * Route the deploy wire. A value that is already a probe STEP (or a per-call function returning
 * one) is used as-is; anything else is sent as a 2xx JSON body. An HTTP status is a NUMBER — a
 * provider status is a string, so discriminating on the key alone would misread a response body.
 */
function routeWire(r: DeployRoutes = {}): void {
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
    if (typeof chosen === 'function') return chosen as never;
    return (isStep(chosen) ? chosen : { json: chosen }) as never;
  };
  wire = sealedFetchProbe({
    // `uploadLeaseData` POSTs the manifest here and ignores the body it gets back.
    '/data': step(r.data, {}),
    '/status': step(r.status, READY_STATUS),
    '/connection': step(r.connection, CONNECTION_BODY),
  });
}

/**
 * The manifest bytes as the PROVIDER received them, taken off the `/data` POST body.
 *
 * Raw `application/octet-stream`, NOT base64-in-JSON — `uploadLeaseData` and `updateLease` frame
 * their payloads differently, and this reads the one the deploy path actually sends.
 */
function uploadedBytes(): Uint8Array {
  const call = wire.calls.find((c) => c.url.endsWith('/data'));
  if (!call) throw new Error('no /data upload was made');
  return call.init.body as Uint8Array;
}

/**
 * Core's broadcast surface: every barrel export that can reach a signing client. Four of the five
 * are invisible to the `cosmosTx` spy in the factory above — `setItemCustomDomain`/`stopApp`/
 * `fundCredits` call `cosmosTx` through their own module-local `'../cosmos.js'` import, and
 * `executeTx` broadcasts straight off `ctx.chain` — because vitest does not rewrite intra-module
 * references. Measured: the `cosmosTx` spy recorded 0 calls while the real `cosmosTx` threw from
 * inside (ENG-713).
 *
 * This file enumerates rather than sealing `ctx.chain` (the approach `restoreApp.test.ts` takes)
 * because the deploy path needs a WORKING `makeMockClientManager` — a query client, an address, a
 * config. That permissive manager is also what makes an escape here dangerous rather than merely
 * ugly: it satisfies every method until `simulate`, so the escape surfaces as
 * `ManifestMCPError(TX_FAILED)` — a plausible error a test could assert on and go green. With no
 * seam to fall back on, the stubs ARE the defence, so they get a guard.
 *
 * Reads are deliberately out of scope: `cosmosQuery` and the `reads.ts` helpers are a different
 * hazard with a different seam (the mock query client), and folding them in would recreate the
 * 85-export problem that makes ENG-715's classify-everything guard untransferable to this barrel.
 *
 * Duplicated per file rather than shared: `vi.mock` is file-scoped, so each file's factory is a
 * separate claim and a shared list would suggest otherwise.
 */
const CORE_BROADCASTERS = [
  'cosmosTx',
  'cosmosEstimateFee',
  'setItemCustomDomain',
  'stopApp',
  'fundCredits',
  'executeTx',
] as const;

describe('core broadcast-surface mock coverage (ENG-713)', () => {
  it('every core broadcaster is stubbed in this file', () => {
    const unstubbed = CORE_BROADCASTERS.filter(
      (name) =>
        !vi.isMockFunction((coreModule as Record<string, unknown>)[name]),
    );
    expect(
      unstubbed,
      'These core exports reached this file REAL. Each can sign and broadcast, and none is\n' +
        'reachable from the cosmosTx spy — stub it in the vi.mock factory above. See ENG-713.',
    ).toEqual([]);
  });

  it('the guard is not vacuous', async () => {
    const names = Object.keys(
      await vi.importActual<
        typeof import('@manifest-network/manifest-mcp-core')
      >('@manifest-network/manifest-mcp-core'),
    );
    expect(names.length).toBeGreaterThan(50);
    for (const name of CORE_BROADCASTERS) {
      expect(names, `${name} is no longer a core barrel export`).toContain(
        name,
      );
    }
  });
});

const mockCosmosTx = vi.mocked(cosmosTx);
const mockSetItemCustomDomain = vi.mocked(setItemCustomDomain);
const getAuthToken = vi.fn(
  async (_address: string, _leaseUuid: string) => 'auth',
);
const getLeaseDataAuthToken = vi.fn(
  async (_address: string, _leaseUuid: string, _metaHashHex: string) =>
    'lease-data',
);

/**
 * Build a FredAuthCtx for the converted `(ctx, spec, callOptions?)` signature.
 * `chain` is the mock client manager (deploy reads getAddress/acquireRateLimit/
 * getQueryClient/cosmosTx off it); `query` is its query client; `providerAuth`
 * adapts the address-param port onto the legacy address-bound token thunks.
 */
async function ctx(cm: unknown): Promise<FredAuthCtx> {
  const manager = cm as any;
  return {
    query: await manager.getQueryClient(),
    chain: manager,
    // The sealed provider wire: the real transport dispatches through it, and an endpoint no
    // test routed fails by name rather than as a plausible network error (ENG-725).
    fetch: wire.fetch,
    logger: noopLogger,
    providerAuth: {
      providerToken: ({ address, leaseUuid }) =>
        getAuthToken(address, leaseUuid),
      leaseDataToken: ({ address, leaseUuid, metaHashHex }) =>
        getLeaseDataAuthToken(address, leaseUuid, metaHashHex),
    },
  };
}
function singleManifest() {
  return JSON.stringify({ image: 'nginx:alpine', ports: { '80/tcp': {} } });
}

function makeQueryClient() {
  return makeMockQueryClient({
    sku: {
      providers: [
        {
          uuid: 'prov-1',
          address: 'manifest1prov',
          apiUrl: 'https://provider.example.com',
          active: true,
        },
      ],
      skus: [
        {
          uuid: 'sku-micro-uuid',
          name: 'docker-micro',
          providerUuid: 'prov-1',
          basePrice: { amount: '36000', denom: 'umfx' },
        },
      ],
      providerLookup: {
        'prov-1': {
          provider: { apiUrl: 'https://provider.example.com' },
        } as any,
      },
    },
  });
}

describe('deployManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      transactionHash: 'TX123',
      code: 0,
      height: '100',
      confirmed: true,
      events: [
        {
          type: 'liftedinit.billing.v1.LeaseCreated',
          attributes: [
            {
              key: 'lease_uuid',
              value: '"550e8400-e29b-41d4-a716-446655440000"',
            },
          ],
        },
      ],
    });

    routeWire();
    // clearAllMocks() resets calls but NOT implementations, so a rejection set by one case
    // would otherwise leak into every later one (the same trap the cosmosTx line below names).
    getAuthToken.mockResolvedValue('auth');
    getLeaseDataAuthToken.mockResolvedValue('lease-data');
    mockSetItemCustomDomain.mockResolvedValue({
      lease_uuid: asLeaseUuid('550e8400-e29b-41d4-a716-446655440000'),
      service_name: 'web',
      custom_domain: asFqdn('app.example.com'),
      transactionHash: 'TX2',
      code: 0,
      confirmed: true,
    });
  });

  it('deploys a single-service manifest and uploads the ORIGINAL bytes', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const manifest = singleManifest();
    const res = await deployManifest(
      await ctx(cm),
      { manifest, sku: { kind: 'byName', size: 'docker-micro' } },
      {},
    );
    expect(res.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    const uploaded = new TextDecoder().decode(uploadedBytes());
    expect(uploaded).toBe(manifest); // byte-identical, not re-serialized
  });

  it('ENG-258 #1: kind:resolved skips the SKU query — trusts the supplied pair verbatim (design §4.3 + §6)', async () => {
    // Pre-resolved IDs must be trusted verbatim: the chain's create-lease is the
    // authoritative validation. Re-querying here would reject momentarily-inactive
    // but valid pins and still not close the TOCTOU window.
    const qc = makeQueryClient(); // contains sku-micro-uuid on prov-1
    const spy = vi.spyOn(qc.liftedinit.sku.v1, 'sKUs');
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });
    await deployManifest(
      await ctx(cm),
      {
        manifest: singleManifest(),
        sku: {
          kind: 'resolved',
          skuUuid: asSkuUuid('sku-micro-uuid'),
          providerUuid: asProviderUuid('prov-1'),
        },
      },
      {},
    );
    // The SKU query must NOT have been called — resolved trusts verbatim.
    expect(spy).not.toHaveBeenCalled();
    // create-lease used the supplied skuUuid verbatim:
    expect(mockCosmosTx.mock.calls[0][3]).toContain('sku-micro-uuid:1');
  });

  it('ENG-258: resolved selector with non-empty ids is trusted verbatim (no SKU query, lease item built from supplied ids)', async () => {
    // Mismatched or unexpected pairs are intentionally NOT rejected here —
    // the chain's create-lease tx is the atomic authoritative check.
    // Only empty strings are rejected (they'd build a malformed `:1` item).
    // Use a SKU uuid that is NOT in the fixture's sku catalog (any-sku-uuid)
    // to confirm that no SKU query is made — we only need prov-1 in
    // providerLookup so resolveProviderUrl can return the provider URL.
    const qc = makeMockQueryClient({
      sku: {
        skus: [
          {
            uuid: 'sku-micro-uuid',
            name: 'docker-micro',
            providerUuid: 'prov-1',
            basePrice: { amount: '36000', denom: 'umfx' },
          },
        ],
        providerLookup: {
          'prov-1': {
            provider: { apiUrl: 'https://provider.example.com' },
          } as any,
        },
      },
    });
    const spy = vi.spyOn(qc.liftedinit.sku.v1, 'sKUs');
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });
    await deployManifest(
      await ctx(cm),
      {
        manifest: singleManifest(),
        sku: {
          kind: 'resolved',
          skuUuid: asSkuUuid('any-sku-uuid'),
          providerUuid: asProviderUuid('prov-1'),
        },
      },
      {},
    );
    expect(spy).not.toHaveBeenCalled();
    expect(mockCosmosTx.mock.calls[0][3]).toContain('any-sku-uuid:1');
  });

  it('rejects a resolved selector with an empty/whitespace skuUuid before any tx', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    await expect(
      deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: {
            kind: 'resolved',
            skuUuid: asSkuUuid('   '),
            providerUuid: asProviderUuid('prov-1'),
          },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    // A malformed pre-resolved SKU must be caught at the boundary, never reach
    // create-lease (an empty skuUuid would build a malformed `:1` lease item).
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('rejects an oversized manifest before any tx', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const huge = JSON.stringify({
      image: 'x',
      ports: { '80/tcp': {} },
      labels: { big: 'A'.repeat(300_000) },
    });
    await expect(
      deployManifest(
        await ctx(cm),
        { manifest: huge, sku: { kind: 'byName', size: 'docker-micro' } },
        {},
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('rejects an invalid manifest BEFORE create-lease', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    await expect(
      deployManifest(
        await ctx(cm),
        {
          manifest: '{"image":""}',
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a traefik.* label',
      { image: 'nginx', labels: { 'traefik.enable': 'true' } },
      'labels["traefik.enable"]',
    ],
    [
      'a mixed-case Fred.* label',
      { image: 'nginx', labels: { 'Fred.owner': 'tenant' } },
      'labels["Fred.owner"]',
    ],
    [
      'a fixed host_port',
      { image: 'nginx', ports: { '80/tcp': { host_port: 8080 } } },
      'ports["80/tcp"].host_port',
    ],
  ])(
    'ENG-637 rejects %s before the paid create-lease broadcast',
    async (_name, manifest, offendingField) => {
      const cm = makeMockClientManager({
        queryClient: makeQueryClient(),
        address: 'manifest1tenant',
      });

      let thrown: unknown;
      try {
        await deployManifest(
          await ctx(cm),
          {
            manifest: JSON.stringify(manifest),
            sku: { kind: 'byName', size: 'docker-micro' },
          },
          {},
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      if (!(thrown instanceof Error))
        throw new Error('expected deploy to fail');
      expect(thrown.message).toContain(offendingField);
      expect(mockCosmosTx).not.toHaveBeenCalled();
      expect(wire.calls).toHaveLength(0);
    },
  );

  it('rejects a top-level __proto__ key', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const manifest =
      '{"image":"nginx","ports":{"80/tcp":{}},"__proto__":{"polluted":true}}';
    await expect(
      deployManifest(
        await ctx(cm),
        { manifest, sku: { kind: 'byName', size: 'docker-micro' } },
        {},
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('rejects a stack manifest with an injection-y service name, with no create-lease', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const manifest = JSON.stringify({
      services: { 'evil:name': { image: 'nginx' } },
    });
    await expect(
      deployManifest(
        await ctx(cm),
        { manifest, sku: { kind: 'byName', size: 'docker-micro' } },
        {},
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'scheme-prefixed domain',
      customDomain: 'https://app.example.com',
      message: /must not include a scheme/,
    },
    {
      label: 'invalid FQDN',
      customDomain: 'not a domain',
      message: /is not a valid FQDN/,
    },
  ])(
    'raw stack manifest rejects a $label before any chain read or side effect',
    async ({ customDomain, message }) => {
      const cm = makeMockClientManager({
        queryClient: makeQueryClient(),
        address: 'manifest1tenant',
      });
      const manifest = JSON.stringify({
        services: { web: { image: 'nginx' } },
      });

      await expect(
        deployManifest(
          await ctx(cm),
          {
            manifest,
            sku: { kind: 'byName', size: 'docker-micro' },
            customDomain,
            serviceName: 'web',
          },
          {},
        ),
      ).rejects.toMatchObject({
        code: ManifestMCPErrorCode.INVALID_ARGUMENT,
        message: expect.stringMatching(message),
      });

      expect(cm.getAddress).not.toHaveBeenCalled();
      expect(cm.acquireRateLimit).not.toHaveBeenCalled();
      expect(mockCosmosTx).not.toHaveBeenCalled();
      expect(mockSetItemCustomDomain).not.toHaveBeenCalled();
      expect(getAuthToken).not.toHaveBeenCalled();
      expect(getLeaseDataAuthToken).not.toHaveBeenCalled();
      expect(wire.calls).toEqual([]);
    },
  );

  it('raw stack manifest reuses the canonical domain for set-domain and result output', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const manifest = JSON.stringify({
      services: { web: { image: 'nginx' } },
    });

    const result = await deployManifest(
      await ctx(cm),
      {
        manifest,
        sku: { kind: 'byName', size: 'docker-micro' },
        customDomain: '  App.Example.COM  ',
        serviceName: 'web',
      },
      {},
    );

    expect(mockSetItemCustomDomain).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: cm,
        logger: expect.anything(),
      }),
      {
        leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
        customDomain: 'app.example.com',
        serviceName: 'web',
      },
      undefined,
    );
    expect(result).toMatchObject({
      custom_domain: 'app.example.com',
      service_name: 'web',
    });
  });

  it('partial failure carries details.partial + failedStep + lease_uuid', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    routeWire({ data: { transportError: new Error('provider 503') } });
    let thrown: any;
    try {
      await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {},
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown.details).toMatchObject({
      partial: true,
      failedStep: 'upload',
      lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(thrown.message).toContain('Deploy partially succeeded:'); // prefix retained
    // ENG-661 regression guard, the OTHER direction: an upload failure means
    // nothing is running, so close_lease IS the honest advice here and this
    // wording must survive the readiness-branch rewording verbatim.
    expect(thrown.message).toContain(
      'Close this lease with close_lease if needed.',
    );
    expect(thrown.details.readiness_unconfirmed).toBeUndefined();
  });

  /**
   * ENG-661. Every post-create-lease failure used to be rewritten as
   * "Deploy partially succeeded: … Close this lease with close_lease if
   * needed" — including a readiness poll that simply ran out of time on a
   * healthy, still-provisioning, already-paid-for lease. That reported a live
   * deployment as failed AND pointed the agent at a destructive tool.
   */
  describe('readiness unconfirmed is NOT a failed deploy', () => {
    /**
     * A provider that keeps answering ACTIVE + `provisioning` — never ready, never failed. The
     * REAL poll then exhausts its deadline and raises `LeaseReadinessUnconfirmedError` with
     * `reason: 'deadline'` and the last status it saw, which is exactly the shape these two cases
     * assert on. Previously that error was hand-constructed and the poll was mocked.
     */
    const stillProvisioning = () => {
      routeWire({
        status: {
          state: 'LEASE_STATE_ACTIVE',
          provision_status: 'provisioning',
        },
      });
      return { intervalMs: 0, timeoutMs: 25 };
    };

    it('does not recommend close_lease, and says the app may still be starting', async () => {
      const cm = makeMockClientManager({
        queryClient: makeQueryClient(),
        address: 'manifest1tenant',
      });
      const pollOptions = stillProvisioning();

      const thrown = await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        { pollOptions },
      ).catch((e: unknown) => e as any);

      expect(thrown.message).not.toContain(
        'Close this lease with close_lease if needed.',
      );
      expect(thrown.message).toContain('NOT a confirmed failure');
      expect(thrown.message).toContain('app_status');
      expect(thrown.message).toContain('wait_for_app_ready');
      expect(thrown.code).toBe('DEPLOY_READINESS_UNCONFIRMED');
      // The ENG-280 cross-version contract survives: agent-core's classifier
      // keys on the prefix and on details.partial.
      expect(thrown.message).toContain('Deploy partially succeeded:');
      expect(thrown.details).toMatchObject({
        partial: true,
        readiness_unconfirmed: true,
        failedStep: 'poll',
        poll_reason: 'deadline',
        last_state: 'LEASE_STATE_ACTIVE',
        last_provision_status: 'provisioning',
        lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
      });
    });

    it('keeps close_lease out of the operator breadcrumb too', async () => {
      const cm = makeMockClientManager({
        queryClient: makeQueryClient(),
        address: 'manifest1tenant',
      });
      const warnLines: string[] = [];
      const warnSpy = vi
        .spyOn(logger, 'warn')
        .mockImplementation((m: unknown) => {
          warnLines.push(String(m));
        });
      const pollOptions = stillProvisioning();

      const thrown = await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        { pollOptions },
      ).catch((e: unknown) => e as any);
      warnSpy.mockRestore();

      const warned = warnLines.join('\n');
      expect(warned).not.toContain('close_lease');
      expect(warned).toContain('do NOT close it');
      expect(warned).not.toContain('undefined');
      expect(warned).toContain(thrown.details.lease_uuid);
    });

    it('a cancel DURING the poll is inconclusive too, and stays OPERATION_CANCELLED', async () => {
      const cm = makeMockClientManager({
        queryClient: makeQueryClient(),
        address: 'manifest1tenant',
      });
      const controller = new AbortController();
      routeWire({
        status: () => {
          controller.abort(new Error('user cancelled'));
          return { transportError: new Error('user cancelled') };
        },
      });

      const thrown = await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        { abortSignal: controller.signal },
      ).catch((e: unknown) => e as any);

      expect(thrown.code).toBe('OPERATION_CANCELLED');
      expect(thrown.details).toMatchObject({
        partial: true,
        readiness_unconfirmed: true,
        failedStep: 'poll',
      });
      expect(thrown.message).toContain('cancelled before readiness');
      expect(thrown.message).not.toContain(
        'Close this lease with close_lease if needed.',
      );
    });

    it('a provider VERDICT keeps the original destructive-cleanup advice', async () => {
      const cm = makeMockClientManager({
        queryClient: makeQueryClient(),
        address: 'manifest1tenant',
      });
      // The provider answered PROVISION_FAILED — an actual verdict, tagged as
      // such by the poll. This is the one poll-step outcome where nothing
      // healthy is running and close_lease is the honest advice.
      // The provider itself answers ACTIVE + `failed`, which the REAL poll turns into the
      // `poll_verdict` error. Previously hand-constructed; now produced by the wire.
      routeWire({
        status: {
          state: 'LEASE_STATE_ACTIVE',
          provision_status: 'failed',
          message: 'image not found',
        },
      });

      const thrown = await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {},
      ).catch((e: unknown) => e as any);

      expect(thrown.message).toContain(
        'Close this lease with close_lease if needed.',
      );
      expect(thrown.details.readiness_unconfirmed).toBeUndefined();
      expect(thrown.details.failedStep).toBe('poll');
      expect(thrown.code).toBe('QUERY_FAILED');
    });

    /**
     * The rule is "only a provider VERDICT justifies close_lease", not "only a
     * deadline is forgivable". These reach the poll after the manifest is
     * already uploaded, and none of them is the provider saying the deployment
     * failed — so none may recommend tearing the lease down.
     */
    // Each row now says how the failure is PRODUCED at the wire rather than handing the poll a
    // pre-built error, so the classification under test covers the transport's own work too.
    // `streamError` is the one shape that reaches the caller with its identity intact — a probe
    // that merely rejects is laundered into a retryable `kind:'network'` by classifyTransportError.
    it.each<[string, () => void]>([
      [
        'a 404 that outlives the tolerance',
        () => routeWire({ status: { status: 404, text: 'lease not found' } }),
      ],
      [
        'an auth rejection',
        () => routeWire({ status: { status: 401, text: 'bad token' } }),
      ],
      [
        'an oversized status body',
        () =>
          routeWire({
            status: {
              streamError: new ProviderApiError(500, 'huge', {
                kind: 'body_cap',
              }),
            },
          }),
      ],
      [
        'a token-mint failure',
        () => getAuthToken.mockRejectedValue(new Error('wallet locked')),
      ],
    ])(
      'reports %s as unconfirmed, never as a failure to clean up',
      async (_label, arrange) => {
        const cm = makeMockClientManager({
          queryClient: makeQueryClient(),
          address: 'manifest1tenant',
        });
        arrange();

        const thrown = await deployManifest(
          await ctx(cm),
          {
            manifest: singleManifest(),
            sku: { kind: 'byName', size: 'docker-micro' },
          },
          // A 404 right after create-lease is TOLERATED by the poll's failure budget, so a real
          // deadline is what turns it into the unconfirmed verdict under test. The non-tolerated
          // rows reach the same verdict on their first read.
          { pollOptions: { intervalMs: 0, timeoutMs: 25 } },
        ).catch((e: unknown) => e as any);

        expect(thrown.message).not.toContain(
          'Close this lease with close_lease if needed.',
        );
        expect(thrown.message).toContain('NOT a confirmed failure');
        expect(thrown.code).toBe('DEPLOY_READINESS_UNCONFIRMED');
        expect(thrown.details).toMatchObject({
          partial: true,
          readiness_unconfirmed: true,
          failedStep: 'poll',
        });
      },
    );

    it('a set-domain or upload failure is still a cleanup case', async () => {
      const cm = makeMockClientManager({
        queryClient: makeQueryClient(),
        address: 'manifest1tenant',
      });
      // Same 401 as above, but at the UPLOAD step: nothing was ever uploaded,
      // so there is no app to protect and close_lease is right.
      routeWire({ data: { status: 401, text: 'bad token' } });

      const thrown = await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {},
      ).catch((e: unknown) => e as any);

      expect(thrown.message).toContain(
        'Close this lease with close_lease if needed.',
      );
      expect(thrown.details.failedStep).toBe('upload');
      expect(thrown.details.readiness_unconfirmed).toBeUndefined();
    });
  });

  it('already-aborted signal creates NO lease — zero side effects (ENG-666)', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const thrown = await deployManifest(
      await ctx(cm),
      {
        manifest: singleManifest(),
        sku: { kind: 'byName', size: 'docker-micro' },
      },
      { abortSignal: AbortSignal.abort() },
    ).catch((e: unknown) => e as any);

    // The pre-broadcast guard fires before create-lease, so nothing is reserved and
    // there is no partial state to report. Previously the abort was noticed only
    // AFTER the lease had been paid for.
    expect(mockCosmosTx).not.toHaveBeenCalled();
    expect(thrown?.name).toBe('AbortError');
  });

  it('abort AFTER create-lease → partial with no misleading failedStep', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const warnLines: string[] = [];
    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation((m: unknown) => {
        warnLines.push(String(m));
      });
    // Abort once the lease exists but before any post-create step has started —
    // the window this test has always been about.
    const controller = new AbortController();
    let thrown: any;
    try {
      await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {
          abortSignal: controller.signal,
          onLeaseCreated: () => controller.abort(),
        },
      );
    } catch (e) {
      thrown = e;
    }
    warnSpy.mockRestore();
    expect(thrown.details?.partial).toBe(true);
    expect(thrown.details?.failedStep).toBeUndefined();
    // A deliberate cancellation is OPERATION_CANCELLED (non-retryable), not the
    // QUERY_FAILED infra-fault fallback used for genuine downstream failures.
    expect(thrown.code).toBe('OPERATION_CANCELLED');
    // The recovery breadcrumb must never interpolate a literal 'undefined'
    // when no post-create step had started before the abort fired.
    expect(warnLines.join('\n')).not.toContain('undefined');
    expect(warnLines.some((l) => l.includes(thrown.details.lease_uuid))).toBe(
      true,
    );
  });

  it('TerminalChainStateError surfaces lease_uuid', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    // `deployManifest` threads `callOptions.pollOptions` straight into the poll, so a caller's
    // `checkChainState` is how this error is reached in production too — the REAL poll raises it.
    // ('closed' is the TerminalChainLeaseState for LEASE_STATE_CLOSED; the callback returns the
    // chain-state string union, not the enum.)
    const warnLines: string[] = [];
    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation((m: unknown) => {
        warnLines.push(String(m));
      });
    let thrown: any;
    try {
      await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {
          pollOptions: {
            intervalMs: 0,
            checkChainState: async () => ({ state: 'closed' as const }),
          },
        },
      );
    } catch (e) {
      thrown = e;
    }
    warnSpy.mockRestore();
    expect(thrown).toBeInstanceOf(TerminalChainStateError);
    expect(thrown.details?.lease_uuid).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    // A terminal chain state isn't remediable with close_lease (the chain
    // already cleared the lease) — the breadcrumb must not suggest it.
    expect(warnLines.join('\n')).not.toContain('close_lease');
  });

  it('logs around create-lease without leaking the manifest body or tokens', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const lines: string[] = [];
    const spyInfo = vi
      .spyOn(logger, 'info')
      .mockImplementation((m: unknown) => {
        lines.push(String(m));
      });
    const spyWarn = vi
      .spyOn(logger, 'warn')
      .mockImplementation((m: unknown) => {
        lines.push(String(m));
      });
    const secret = 'TOPSECRETIMAGE';
    await deployManifest(
      await ctx(cm),
      {
        manifest: JSON.stringify({ image: secret, ports: { '80/tcp': {} } }),
        sku: { kind: 'byName', size: 'docker-micro' },
      },
      {},
    );
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.some((l) => l.includes('lease'))).toBe(true);
    spyInfo.mockRestore();
    spyWarn.mockRestore();
  });

  it('wrapper: builder output passes validateManifest (no self-built manifest is rejected)', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    // a representative typed input that exercises many builder fields:
    await expect(
      deployApp(
        await ctx(cm as any),
        {
          image: 'nginx:alpine',
          port: 80,
          size: 'docker-micro',
          env: { FOO: 'bar' },
          command: ['sh'],
          labels: { a: 'b' },
        },
        {},
      ),
    ).resolves.toMatchObject({ state: LeaseState.LEASE_STATE_ACTIVE });
  });

  it('ENG-258 #1: throws SKU_AMBIGUOUS (no provider) for a duplicate name', async () => {
    const qc = makeMockQueryClient({
      sku: {
        skus: [
          {
            uuid: 'a',
            name: 'docker-micro',
            providerUuid: 'p1',
            basePrice: { amount: '1', denom: 'umfx' },
          },
          {
            uuid: 'b',
            name: 'docker-micro',
            providerUuid: 'p2',
            basePrice: { amount: '2', denom: 'umfx' },
          },
        ],
        providerLookup: {
          p1: { provider: { apiUrl: 'https://p1.example.com' } } as never,
        },
      },
    });
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });
    await expect(
      deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.SKU_AMBIGUOUS });
    expect(mockCosmosTx).not.toHaveBeenCalled(); // no broadcast on ambiguity
  });

  it('ENG-258 #1: resolves a duplicate name when providerUuid narrows it', async () => {
    const qc = makeMockQueryClient({
      sku: {
        skus: [
          {
            uuid: 'a',
            name: 'docker-micro',
            providerUuid: 'p1',
            basePrice: { amount: '1', denom: 'umfx' },
          },
          {
            uuid: 'b',
            name: 'docker-micro',
            providerUuid: 'p2',
            basePrice: { amount: '2', denom: 'umfx' },
          },
        ],
        providerLookup: {
          p2: { provider: { apiUrl: 'https://p2.example.com' } } as never,
        },
      },
    });
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });
    await deployManifest(
      await ctx(cm),
      {
        manifest: singleManifest(),
        sku: {
          kind: 'byName',
          size: 'docker-micro',
          providerUuid: asProviderUuid('p2'),
        },
      },
      {},
    );
    expect(mockCosmosTx.mock.calls[0][3]).toContain('b:1'); // used p2's sku
  });

  it('ENG-258: deployApp with sku_uuid + provider_uuid uses the resolved selector (skips chain query — trusts verbatim)', async () => {
    const qc = makeMockQueryClient({
      sku: {
        skus: [
          {
            uuid: 'a',
            name: 'docker-micro',
            providerUuid: 'p1',
            basePrice: { amount: '1', denom: 'umfx' },
          },
          {
            uuid: 'b',
            name: 'docker-micro',
            providerUuid: 'p2',
            basePrice: { amount: '2', denom: 'umfx' },
          },
        ],
        providerLookup: {
          p2: { provider: { apiUrl: 'https://p2.example.com' } } as never,
        },
      },
    });
    const spy = vi.spyOn(qc.liftedinit.sku.v1, 'sKUs');
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });
    await deployApp(
      await ctx(cm as never),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        skuUuid: 'b',
        providerUuid: 'p2',
      },
      {},
    );
    // Both ids present → resolved selector → no chain query (trusted verbatim).
    expect(spy).not.toHaveBeenCalled();
    expect(mockCosmosTx.mock.calls[0][3]).toContain('b:1');
  });

  it('ENG-258: deployApp with sku_uuid ALONE routes through byName (queries the chain to learn the provider)', async () => {
    // Duplicate name: a byName-without-disambiguator would be SKU_AMBIGUOUS, so a
    // successful broadcast of b's item proves skuUuid pinned it via resolveSku's
    // uuid lookup (which DOES query the chain to learn b's provider).
    const qc = makeMockQueryClient({
      sku: {
        skus: [
          {
            uuid: 'a',
            name: 'docker-micro',
            providerUuid: 'p1',
            basePrice: { amount: '1', denom: 'umfx' },
          },
          {
            uuid: 'b',
            name: 'docker-micro',
            providerUuid: 'p2',
            basePrice: { amount: '2', denom: 'umfx' },
          },
        ],
        providerLookup: {
          p2: { provider: { apiUrl: 'https://p2.example.com' } } as never,
        },
      },
    });
    const spy = vi.spyOn(qc.liftedinit.sku.v1, 'sKUs');
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });
    await deployApp(
      await ctx(cm as never),
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        skuUuid: 'b',
        // no providerUuid → byName branch, but skuUuid pins the result.
      },
      {},
    );
    // skuUuid-only → byName → resolveSku queries the chain to look up b's provider.
    expect(spy).toHaveBeenCalled();
    expect(mockCosmosTx.mock.calls[0][3]).toContain('b:1');
  });
});
