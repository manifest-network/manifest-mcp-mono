/**
 * Shared decoding for `leases_by_tenant` responses. 1:1 port of
 * `manifest-agent-plugin/scripts/_lease-items.cjs`.
 *
 * The CJS docstring described `extract-lease-items.cjs` (orchestrator entry)
 * and `verify-domain-state.cjs` as the two callers that decode the same
 * lease shape: walk `leases[]`, match by UUID, normalize each item's
 * serviceName/customDomain across snake_case/camelCase variants. The
 * TS port lifts the helpers in the same shape. `verify-domain-state.ts`
 * is the in-package consumer for PR 1; PR 4's `manageDomain` / `troubleshoot`
 * will also consume.
 *
 * Exports:
 *   - `pickLeasesArray(payload)` — tolerate `{ leases: [...] }` (current
 *     chain shape) and a bare array. Throws on anything else.
 *   - `normalizeItem(rawItem)` — return `{ serviceName, customDomain }`
 *     with empty-string defaults; accepts both camelCase and snake_case.
 *   - `findLease(payload, leaseUuid)` — `pickLeasesArray` + UUID lookup.
 *     Case-insensitive; tolerates `uuid` / `lease_uuid` / `leaseUuid` keys.
 *     Returns the matched lease object (raw shape) or `null`. Throws
 *     `TypeError` when `leaseUuid` is not a string.
 */

export interface NormalizedLeaseItem {
  serviceName: string;
  customDomain: string;
}

/**
 * Tolerate either `{ leases: [...] }` (current chain shape) or a bare
 * array. Throws on anything else.
 */
export function pickLeasesArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (
    payload !== null &&
    typeof payload === 'object' &&
    Array.isArray((payload as { leases?: unknown }).leases)
  ) {
    return (payload as { leases: unknown[] }).leases;
  }
  throw new Error(
    'leases_by_tenant response: expected `leases[]` array or bare array',
  );
}

/**
 * Normalize a raw lease-item record (chain snake_case OR proto-decoded
 * camelCase) into `{ serviceName, customDomain }` with empty-string
 * defaults on missing fields.
 */
export function normalizeItem(raw: unknown): NormalizedLeaseItem {
  if (raw === null || typeof raw !== 'object') {
    return { serviceName: '', customDomain: '' };
  }
  const r = raw as {
    serviceName?: unknown;
    service_name?: unknown;
    customDomain?: unknown;
    custom_domain?: unknown;
  };
  const serviceName =
    readStringOrEmpty(r.serviceName) || readStringOrEmpty(r.service_name);
  const customDomain =
    readStringOrEmpty(r.customDomain) || readStringOrEmpty(r.custom_domain);
  return { serviceName, customDomain };
}

/**
 * Find a lease by UUID inside a `leases_by_tenant` response. Lookup is
 * case-insensitive and tolerates `uuid`, `lease_uuid`, or `leaseUuid`
 * fields on the lease object. Returns the raw lease record or `null`.
 *
 * Throws `TypeError` if `leaseUuid` is not a string. Both production
 * callers (verify-domain-state, future manageDomain) pre-validate against
 * a UUID regex, but the helper guards anyway — a clear error beats a
 * "Cannot read properties of …" stack trace.
 */
export function findLease(payload: unknown, leaseUuid: string): unknown | null {
  if (typeof leaseUuid !== 'string') {
    const got = leaseUuid === null ? 'null' : typeof leaseUuid;
    throw new TypeError(`findLease: leaseUuid must be a string, got ${got}`);
  }
  const leases = pickLeasesArray(payload);
  const target = leaseUuid.toLowerCase();
  for (const lease of leases) {
    if (lease === null || typeof lease !== 'object') continue;
    const r = lease as {
      uuid?: unknown;
      lease_uuid?: unknown;
      leaseUuid?: unknown;
    };
    const u = r.uuid ?? r.lease_uuid ?? r.leaseUuid;
    if (typeof u === 'string' && u.toLowerCase() === target) {
      return lease;
    }
  }
  return null;
}

function readStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
