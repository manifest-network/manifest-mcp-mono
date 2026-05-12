import { findLease, normalizeItem } from './lease-items.js';

/**
 * Verify a lease item's `customDomain` against an expected value after a
 * `set_item_custom_domain` broadcast. 1:1 port of
 * `manifest-agent-plugin/scripts/verify-domain-state.cjs`.
 *
 * Decodes the same lease shape as `lease-items.ts`, then compares the
 * matched item's `customDomain` to the expected FQDN (or empty string for
 * clear-mode). Used by the in-process `verifyAndRecover` driver in PR 1
 * and by the high-level `manageDomain` set/clear flows in PR 4.
 *
 * Outcome semantics (preserved from CJS):
 *   - `'match'`     — actual `customDomain` equals expected
 *   - `'mismatch'`  — actual differs from expected (item carries `actual` for surfacing)
 *   - `'not_found'` — lease UUID not in tenant payload, OR multi-item lease but no `serviceName` supplied, OR `serviceName` not present in the lease's items
 *
 * Single-item leases (legacy 1-item lease with `serviceName === ''`) ignore
 * the `serviceName` argument and always use the only item. Multi-item
 * stack leases require `serviceName` to address the target item.
 *
 * Throws `TypeError` for malformed args (non-string leaseUuid, leaseUuid
 * that doesn't match UUID grammar). The CJS exits 1 via stderr; the TS
 * port surfaces a typed error instead of a synthetic `not_found` result
 * so caller-side argument bugs don't masquerade as a chain-state outcome.
 */

/** Anchored UUID-shape regex (8-4-4-4-12, version-byte lenient — matches `_uuid.cjs#UUID_RE`). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VerifyDomainOutcome = 'match' | 'mismatch' | 'not_found';

export interface VerifyDomainResult {
  outcome: VerifyDomainOutcome;
  /** Present when outcome is 'match' or 'mismatch'. The lease item's actual customDomain. */
  actual?: string;
  /** Present when outcome is 'not_found'. Human-readable detail. */
  reason?: string;
}

export interface VerifyDomainArgs {
  leaseUuid: string;
  /** DNS label addressing an item inside a stack lease. Omit / leave empty for legacy 1-item leases. */
  serviceName?: string;
  /** FQDN to compare against the chain's stored value. Use '' for clear-mode (post-clear verification). */
  expected: string;
}

export function verifyDomainState(
  leasesByTenantResponse: unknown,
  args: VerifyDomainArgs,
): VerifyDomainResult {
  if (typeof args.leaseUuid !== 'string') {
    throw new TypeError(
      `verifyDomainState: leaseUuid must be a string, got ${typeof args.leaseUuid}`,
    );
  }
  if (!UUID_RE.test(args.leaseUuid)) {
    throw new TypeError(
      `verifyDomainState: leaseUuid must be a UUID; got "${args.leaseUuid}"`,
    );
  }
  if (typeof args.expected !== 'string') {
    throw new TypeError(
      `verifyDomainState: expected must be a string (use '' for clear-mode), got ${typeof args.expected}`,
    );
  }

  const lease = findLease(leasesByTenantResponse, args.leaseUuid);
  if (lease === null) {
    return {
      outcome: 'not_found',
      reason: 'lease UUID not in tenant leases',
    };
  }

  // The lease shape is opaque to TS — pickLeasesArray + findLease validate
  // structural keys but the items array can be missing or non-array.
  const rawItems = (lease as { items?: unknown }).items;
  const itemsArray = Array.isArray(rawItems) ? rawItems : [];
  const items = itemsArray.map(normalizeItem);

  const singleItem = items.length === 1 && items[0]?.serviceName === '';
  const requestedService = (args.serviceName ?? '').trim();

  let item: ReturnType<typeof normalizeItem> | undefined;
  if (singleItem) {
    item = items[0];
  } else if (requestedService === '') {
    return {
      outcome: 'not_found',
      reason: 'lease has multiple items but --service-name was not supplied',
    };
  } else {
    item = items.find((i) => i.serviceName === requestedService);
    if (!item) {
      return {
        outcome: 'not_found',
        reason: `service-name "${requestedService}" not found in lease items`,
      };
    }
  }

  const actual = item?.customDomain ?? '';
  const outcome: VerifyDomainOutcome =
    actual === args.expected ? 'match' : 'mismatch';
  return { outcome, actual };
}
