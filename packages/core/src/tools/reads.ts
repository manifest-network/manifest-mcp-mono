import type {
  Lease,
  LeaseItem,
  LeaseState,
} from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import {
  asAddress,
  asFqdn,
  asLeaseUuid,
  asProviderUuid,
  asSkuUuid,
} from '../brands.js';
import type { ReadCtx } from '../ctx.js';
import { isNotFoundError } from '../internals/classify-query-error.js';
import { withReadSignal } from '../internals/read-signal.js';
import type {
  BrandedLease,
  BrandedLeaseItem,
  BrandedProvider,
  BrandedSKU,
} from '../manifest-types.js';
import type { CallOptions } from '../options.js';
import {
  type BillingParams,
  type Coin,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '../types.js';
import { assertUuid } from '../validation.js';

// ===== Module-private branded-view producers (OI-PRODUCERS: mirror sku-resolution.ts's toCandidate;
// the view types stay pure-data in manifest-types.ts). Brand-on-extraction via the as* trust-cast
// family ONLY — chain reads are trusted; re-validating would throw on non-canonical-but-valid ids
// (ENG-258 parse-once). =====

function toBrandedLeaseItem(i: LeaseItem): BrandedLeaseItem {
  return {
    ...i,
    skuUuid: asSkuUuid(i.skuUuid),
    customDomain: asFqdn(i.customDomain),
  };
}

function toBrandedLease(l: Lease): BrandedLease {
  return {
    ...l,
    uuid: asLeaseUuid(l.uuid),
    tenant: asAddress(l.tenant),
    providerUuid: asProviderUuid(l.providerUuid),
    // RUNTIME guard `?? []` (BrandedLease.items stays the REQUIRED BrandedLeaseItem[] type): a real lease
    // always has items, but partial test fixtures may omit it — a bare l.items.map throws TypeError.
    // Matches the handler's existing defensive `l.items?.map` (lease/index.ts). Do NOT tighten it back.
    items: (l.items ?? []).map(toBrandedLeaseItem),
  };
}

export async function getLeasesByTenant(
  ctx: ReadCtx,
  input: {
    tenant: string;
    stateFilter: LeaseState;
    limit?: bigint;
    offset?: bigint;
  },
  opts?: CallOptions,
): Promise<{ leases: BrandedLease[]; total: bigint }> {
  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.billing.v1.leasesByTenant({
        tenant: input.tenant,
        stateFilter: input.stateFilter,
        pagination: {
          key: new Uint8Array(),
          offset: input.offset ?? 0n,
          limit: input.limit ?? 50n,
          countTotal: true,
          reverse: false,
        },
      }),
    opts,
  );
  return {
    leases: r.leases.map(toBrandedLease),
    total: r.pagination?.total ?? 0n,
  };
}

export async function getLease(
  ctx: ReadCtx,
  leaseUuid: string,
  opts?: CallOptions,
): Promise<BrandedLease | null> {
  // MUST precede the read: the keeper answers `code:5 "lease not found"` for a
  // malformed uuid too, so without this a typo would return null — making null
  // mean both "absent" and "you sent garbage" (ENG-536).
  assertUuid(leaseUuid, 'lease_uuid', ManifestMCPErrorCode.INVALID_ARGUMENT);

  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.billing.v1
        .lease({ leaseUuid })
        .catch((error: unknown) => {
          // .catch scoped to the INNER read so AbortError/TimeoutError propagate (OI-CATCH)
          if (isNotFoundError(error)) return null;
          throw error;
        }),
    opts,
  );
  if (r === null) return null;
  // QueryLeaseResponse.lease is statically non-optional, but we guard null for parity with getBalance's
  // catchNotFound idiom + the mocks.ts {lease:null} shape; future P2 consumers disambiguate null. Do NOT
  // "simplify" to a non-null return — it breaks the mock-backed null test.
  return r.lease ? toBrandedLease(r.lease) : null;
}

export async function getLeaseByCustomDomain(
  ctx: ReadCtx,
  customDomain: string,
  opts?: CallOptions,
): Promise<{ lease: BrandedLease; serviceName: string }> {
  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.billing.v1
        .leaseByCustomDomain({ customDomain })
        .catch((error: unknown) => {
          // .catch scoped to the INNER read so AbortError/TimeoutError propagate (OI-CATCH)
          if (error instanceof ManifestMCPError) throw error;
          throw new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            `lease_by_custom_domain failed: ${error instanceof Error ? error.message : String(error)}`,
            { customDomain },
          );
        }),
    opts,
  );
  return { lease: toBrandedLease(r.lease), serviceName: r.serviceName };
}

export async function getSKUs(
  ctx: ReadCtx,
  input: { activeOnly?: boolean },
  opts?: CallOptions,
): Promise<BrandedSKU[]> {
  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.sku.v1.sKUs({
        activeOnly: input.activeOnly ?? true,
      }),
    opts,
  );
  return r.skus.map((s) => ({
    ...s,
    uuid: asSkuUuid(s.uuid),
    providerUuid: asProviderUuid(s.providerUuid),
  }));
}

export async function getProviders(
  ctx: ReadCtx,
  input: { activeOnly?: boolean },
  opts?: CallOptions,
): Promise<BrandedProvider[]> {
  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.sku.v1.providers({
        activeOnly: input.activeOnly ?? true,
      }),
    opts,
  );
  return r.providers.map((p) => ({
    ...p,
    uuid: asProviderUuid(p.uuid),
    address: asAddress(p.address),
    payoutAddress: asAddress(p.payoutAddress),
  }));
}

export async function getBillingParams(
  ctx: ReadCtx,
  opts?: CallOptions,
): Promise<BillingParams> {
  const r = await withReadSignal(
    ctx,
    () => ctx.query.liftedinit.billing.v1.params({}),
    opts,
  );
  return r.params;
}

export async function getWithdrawableAmount(
  ctx: ReadCtx,
  leaseUuid: string,
  opts?: CallOptions,
): Promise<Coin[] | null> {
  assertUuid(leaseUuid, 'lease_uuid', ManifestMCPErrorCode.INVALID_ARGUMENT);

  const r = await withReadSignal(
    ctx,
    () =>
      ctx.query.liftedinit.billing.v1
        .withdrawableAmount({ leaseUuid })
        .catch((error: unknown) => {
          // .catch scoped to the INNER read so AbortError/TimeoutError propagate (OI-CATCH)
          if (isNotFoundError(error)) return null;
          throw error;
        }),
    opts,
  );
  return r === null ? null : r.amounts;
}
