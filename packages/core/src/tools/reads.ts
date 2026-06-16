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
import { withReadSignal } from '../internals/read-signal.js';
import type { BrandedLease, BrandedLeaseItem } from '../manifest-types.js';
import type { CallOptions } from '../options.js';

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
  const r = await withReadSignal(
    ctx,
    () => ctx.query.liftedinit.billing.v1.lease({ leaseUuid }),
    opts,
  );
  // QueryLeaseResponse.lease is statically non-optional, but we guard null for parity with getBalance's
  // catchNotFound idiom + the mocks.ts {lease:null} shape; future P2 consumers disambiguate null. Do NOT
  // "simplify" to a non-null return — it breaks the mock-backed null test.
  return r.lease ? toBrandedLease(r.lease) : null;
}
