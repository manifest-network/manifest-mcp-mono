import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return { ...actual, cosmosTx: vi.fn(), setItemCustomDomain: vi.fn() };
});

vi.mock('../http/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/provider.js')>();
  return {
    ...actual,
    uploadLeaseData: vi.fn(),
    getLeaseConnectionInfo: vi.fn(),
  };
});

vi.mock('../http/fred.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/fred.js')>();
  return { ...actual, pollLeaseUntilReady: vi.fn() };
});

import {
  asProviderUuid,
  asSkuUuid,
  cosmosTx,
  LeaseState,
  logger,
  ManifestMCPErrorCode,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import {
  makeMockClientManager,
  makeMockQueryClient,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import type { FredAuthCtx } from '../ctx.js';
import {
  LeaseReadinessUnconfirmedError,
  pollLeaseUntilReady,
  TerminalChainStateError,
} from '../http/fred.js';
import {
  getLeaseConnectionInfo,
  ProviderApiError,
  uploadLeaseData,
} from '../http/provider.js';
import { deployApp } from './deployApp.js';
import { deployManifest } from './deployManifest.js';

const mockCosmosTx = vi.mocked(cosmosTx);
const mockUpload = vi.mocked(uploadLeaseData);
const mockPoll = vi.mocked(pollLeaseUntilReady);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);
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
    fetch: vi.fn(globalThis.fetch),
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

    mockUpload.mockResolvedValue(undefined);
    mockPoll.mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    mockGetLeaseConnectionInfo.mockResolvedValue({
      lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
      tenant: 'manifest1tenant',
      provider_uuid: 'prov-1',
      connection: {
        host: 'app.localhost',
        ports: { '80/tcp': 32001 },
      },
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
    const uploaded = new TextDecoder().decode(mockUpload.mock.calls[0][2]);
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

  it('partial failure carries details.partial + failedStep + lease_uuid', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    mockUpload.mockRejectedValueOnce(new Error('provider 503'));
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
    const readinessTimedOut = () =>
      new LeaseReadinessUnconfirmedError({
        leaseUuid: '550e8400-e29b-41d4-a716-446655440000',
        reason: 'deadline',
        timeoutMs: 600_000,
        elapsedMs: 600_001,
        lastState: LeaseState.LEASE_STATE_ACTIVE,
        lastProvisionStatus: 'provisioning',
      });

    it('does not recommend close_lease, and says the app may still be starting', async () => {
      const cm = makeMockClientManager({
        queryClient: makeQueryClient(),
        address: 'manifest1tenant',
      });
      mockPoll.mockRejectedValueOnce(readinessTimedOut());

      const thrown = await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {},
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
      mockPoll.mockRejectedValueOnce(readinessTimedOut());

      const thrown = await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        {},
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
      mockPoll.mockImplementationOnce(async () => {
        controller.abort(new Error('user cancelled'));
        throw new Error('user cancelled');
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
      mockPoll.mockRejectedValueOnce(
        new ProviderApiError(
          0,
          'Lease … is ACTIVE but provisioning failed: image not found',
          { kind: 'poll_verdict' },
        ),
      );

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
    it.each([
      [
        'a 404 that outlives the tolerance',
        new ProviderApiError(404, 'lease not found', { kind: 'http' }),
      ],
      [
        'an auth rejection',
        new ProviderApiError(401, 'bad token', { kind: 'http' }),
      ],
      [
        'an oversized status body',
        new ProviderApiError(500, 'huge', { kind: 'body_cap' }),
      ],
      ['a token-mint failure', new Error('wallet locked')],
    ])(
      'reports %s as unconfirmed, never as a failure to clean up',
      async (_label, pollError) => {
        const cm = makeMockClientManager({
          queryClient: makeQueryClient(),
          address: 'manifest1tenant',
        });
        mockPoll.mockRejectedValueOnce(pollError);

        const thrown = await deployManifest(
          await ctx(cm),
          {
            manifest: singleManifest(),
            sku: { kind: 'byName', size: 'docker-micro' },
          },
          {},
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
      mockUpload.mockRejectedValueOnce(
        new ProviderApiError(401, 'bad token', { kind: 'http' }),
      );

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

  it('already-aborted signal → partial with no misleading failedStep', async () => {
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
    let thrown: any;
    try {
      await deployManifest(
        await ctx(cm),
        {
          manifest: singleManifest(),
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        { abortSignal: AbortSignal.abort() },
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
    mockPoll.mockImplementationOnce(async () => {
      // 'closed' is the TerminalChainLeaseState for LEASE_STATE_CLOSED
      // (the constructor takes the chain-state string union, not the enum).
      throw new TerminalChainStateError(
        '550e8400-e29b-41d4-a716-446655440000',
        'closed',
      );
    });
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
        {},
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
