import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { describe, expect, it, vi } from 'vitest';
import {
  makeMockClientManager,
  makeMockQueryClient,
  makeReadCtx,
} from './__test-utils__/mocks.js';
import type { CosmosClientManager } from './client.js';
import { cosmosQuery } from './cosmos.js';
import { bigIntReplacer } from './server-utils.js';
import {
  getBillingParams,
  getLease,
  getLeaseByCustomDomain,
  getLeasesByTenant,
  getProviders,
  getSKUs,
  getWithdrawableAmount,
} from './tools/reads.js';
import { ManifestMCPErrorCode } from './types.js';

// §9 CROSS-FACE EQUIVALENCE — brand-erased VALUE equivalence over the OVERLAPPING chain data
// (NOT whole-object identity). `cosmosQuery(clientManager, module, subcommand, args)` returns a
// `{ module, subcommand, result }` envelope; the typed reads deliberately unwrap/reshape it, so each
// fn is compared against `stringly.result.<field>` per-fn. bigint-bearing values are normalized
// through `bigIntReplacer` first (a raw JSON.stringify over manifestjs bigint fields throws);
// brands erase at runtime, so a normalized `toEqual` is a true VALUE-equivalence assertion.
//
// COMPOSITE reads (getBalance / resolveSku / listSkuCandidates) are NOT 1:1 over a single
// cosmos_query subcommand — they compose multiple chain reads / reshape — so they have NO
// equivalence test here BY DESIGN. Do NOT "fix" the gap by adding one.

/** Normalize through bigIntReplacer so the two faces compare as VALUES (bigint fields → strings). */
function norm(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, bigIntReplacer));
}

/** `cosmosQuery`'s `result` is the discriminated `QueryResult` union; the per-fn mock shape is known. */
function field(stringly: { result: unknown }, key: string): unknown {
  return (stringly.result as Record<string, unknown>)[key];
}

/** A ReadCtx whose `chain` is the SAME client manager `cosmosQuery` routes through (one mock client). */
function makeCrossfaceCtx(client: ReturnType<typeof makeMockQueryClient>) {
  const chain = makeMockClientManager({
    queryClient: client,
  }) as unknown as CosmosClientManager;
  return {
    ctx: makeReadCtx({ query: client, chain }),
    chain,
  };
}

describe('§9 cross-face equivalence (typed read vs cosmos_query stringly face)', () => {
  it('getLeasesByTenant equals billing leases-by-tenant', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          {
            uuid: 'lease-uuid-1',
            providerUuid: 'provider-uuid-1',
            createdAt: new Date(0),
          },
        ],
      },
    });
    const { ctx, chain } = makeCrossfaceCtx(client);
    // Use UNSPECIFIED so both faces key the mock on stateFilter 0 (the stringly handler hardcodes 0).
    const typed = await getLeasesByTenant(ctx, {
      tenant: 'manifest1tenant',
      stateFilter: LeaseState.LEASE_STATE_UNSPECIFIED,
    });
    const stringly = await cosmosQuery(chain, 'billing', 'leases-by-tenant', [
      'manifest1tenant',
    ]);
    // toMatchObject (not toEqual): the typed face MATERIALIZES `items: []` (the toBrandedLease `?? []`
    // guard) which the raw chain face omits — that `[]` is a typed-side default, NOT overlapping chain
    // data. §9 is brand-erased VALUE equivalence over the OVERLAPPING data, so the raw lease must be a
    // (brand-erased) subset of the typed one — every chain-returned field present + equal.
    expect(norm(typed.leases)).toMatchObject(
      norm(field(stringly, 'leases')) as object,
    );
    const pagination = field(stringly, 'pagination') as
      | { total?: bigint }
      | undefined;
    expect(typed.total).toBe(pagination?.total ?? 0n);
  });

  it('getLease equals billing lease', async () => {
    const client = makeMockQueryClient({
      billing: {
        lease: {
          uuid: 'lease-uuid-1',
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'provider-uuid-1',
          createdAt: new Date(0),
        },
      },
    });
    const { ctx, chain } = makeCrossfaceCtx(client);
    const typed = await getLease(ctx, 'lease-uuid-1');
    const stringly = await cosmosQuery(chain, 'billing', 'lease', [
      'lease-uuid-1',
    ]);
    // toMatchObject (not toEqual): same `items: []` materialization rationale as getLeasesByTenant —
    // the raw chain lease is a brand-erased subset of the typed BrandedLease.
    expect(norm(typed)).toMatchObject(norm(field(stringly, 'lease')) as object);
  });

  it('getLeaseByCustomDomain equals billing lease-by-custom-domain', async () => {
    const client = makeMockQueryClient();
    const { ctx, chain } = makeCrossfaceCtx(client);
    const typed = await getLeaseByCustomDomain(ctx, 'app.example.com');
    const stringly = await cosmosQuery(
      chain,
      'billing',
      'lease-by-custom-domain',
      ['app.example.com'],
    );
    expect(norm(typed)).toEqual(norm(stringly.result));
  });

  it('getLeaseByCustomDomain and the stringly face surface the SAME ManifestMCPErrorCode (QUERY_FAILED)', async () => {
    const client = makeMockQueryClient();
    vi.mocked(
      client.liftedinit.billing.v1.leaseByCustomDomain,
    ).mockRejectedValue(new Error('boom'));
    const { ctx, chain } = makeCrossfaceCtx(client);
    // NON-empty garbage domain: the stringly handler throws INVALID_CONFIG on empty/whitespace BEFORE
    // the chain (a pre-check the typed core fn lacks), so an empty domain would compare
    // INVALID_CONFIG ≠ QUERY_FAILED. A non-empty domain reaches the rejecting mock on both faces.
    await expect(
      getLeaseByCustomDomain(ctx, 'garbage.invalid'),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
    await expect(
      cosmosQuery(chain, 'billing', 'lease-by-custom-domain', [
        'garbage.invalid',
      ]),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
  });

  it('getSKUs equals sku skus', async () => {
    const client = makeMockQueryClient({
      sku: {
        skus: [
          { uuid: 'sku-uuid-1', name: 'web', providerUuid: 'provider-uuid-1' },
        ],
      },
    });
    const { ctx, chain } = makeCrossfaceCtx(client);
    const typed = await getSKUs(ctx, { activeOnly: true });
    const stringly = await cosmosQuery(chain, 'sku', 'skus', []);
    expect(norm(typed)).toEqual(norm(field(stringly, 'skus')));
  });

  it('getProviders equals sku providers', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [
          {
            uuid: 'provider-uuid-1',
            address: 'manifest1provider',
            payoutAddress: 'manifest1payout',
            apiUrl: 'https://provider.example.com',
            active: true,
          },
        ],
      },
    });
    const { ctx, chain } = makeCrossfaceCtx(client);
    const typed = await getProviders(ctx, { activeOnly: true });
    const stringly = await cosmosQuery(chain, 'sku', 'providers', []);
    expect(norm(typed)).toEqual(norm(field(stringly, 'providers')));
  });

  it('getBillingParams equals billing params', async () => {
    const client = makeMockQueryClient();
    const { ctx, chain } = makeCrossfaceCtx(client);
    const typed = await getBillingParams(ctx);
    const stringly = await cosmosQuery(chain, 'billing', 'params', []);
    expect(norm(typed)).toEqual(norm(field(stringly, 'params')));
  });

  it('getWithdrawableAmount equals billing withdrawable-amount', async () => {
    const client = makeMockQueryClient({
      billing: { withdrawableAmount: [{ denom: 'upwr', amount: '100' }] },
    });
    const { ctx, chain } = makeCrossfaceCtx(client);
    const typed = await getWithdrawableAmount(ctx, 'lease-uuid-1');
    const stringly = await cosmosQuery(
      chain,
      'billing',
      'withdrawable-amount',
      ['lease-uuid-1'],
    );
    expect(norm(typed)).toEqual(norm(field(stringly, 'amounts')));
  });
});
