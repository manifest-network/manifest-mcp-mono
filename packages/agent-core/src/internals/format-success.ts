import {
  type RunningEndpoint,
  extractRunningEndpoints,
  formatEndpointAsIngress,
} from './connection.js';
import { decode as decodeLeaseState } from './lease-state.js';

/**
 * Render the user-facing "Deployed." block for a successful `deployApp` run.
 *
 * Port of `manifest-agent-plugin/scripts/format-success.cjs` (plugin git-hash
 * `3a33e80`). The CJS reads `lease-uuid` as a CLI arg and `deploy_response`
 * via stdin; the TS port takes both via the typed `FormatSuccessInput`.
 *
 * Output is plain text suitable for direct chat display. Designed to be
 * printed verbatim by `deployApp` (and downstream renderers) — no
 * paraphrasing or surrounding prose.
 *
 * **Lease-state decoding:** `deploy_response.state` may be an integer (raw
 * chain emit) or a `LEASE_STATE_*` string (codec.toJSON form). Both flow
 * through `lease-state.ts:decode`. Unknown values render as
 * `UNKNOWN(<raw>)` so the raw remains visible.
 *
 * **Multi-instance / multi-service stacks** emit `Ingresses:` followed by
 * one bare FQDN per UNIQUE FQDN across running instances. Instances
 * sharing an FQDN (e.g. replicas behind one subdomain) are deduped by
 * `extractRunningEndpoints`.
 *
 * **Custom-domain line** is emitted BEFORE the Ingress block when the
 * deploy response carries a `custom_domain` (the set-domain tx confirmed
 * alongside create-lease). The "(provisioning)" qualifier reflects that
 * the chain tx confirmed but the provider may still be issuing the cert.
 *
 * **Provider rendering**: the CJS once attempted to resolve a friendly
 * provider name via `browse_catalog` and dropped it when upstream's
 * catalog shape carried no `name` field. The TS port keeps the
 * `provider_uuid` rendering for the same reason — if upstream later adds
 * `name`, restore via a thin helper.
 */

/** RFC 4122 UUID — 36 chars, hex + 4 hyphens, lowercase or upper. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Deploy response shape consumed by `formatSuccess`. Subset of fred's `mcp__manifest-fred__deploy_app` response. */
export interface DeployResponse {
  /** Chain lease state — int (raw) or `LEASE_STATE_*` string (codec). */
  state?: number | string;
  /** Provider UUID — rendered as-is (catalog has no friendly-name field). */
  provider_uuid?: string;
  /** Custom domain attached to the lease item; populated when set-domain confirmed. */
  custom_domain?: string;
  /** Provider connection payload — walked by `connection.ts`. */
  connection?: unknown;
}

export interface FormatSuccessInput {
  /** Validated lease UUID (RFC 4122 v1-v5). */
  leaseUuid: string;
  /** Deploy response from `deploy_app` (or equivalent atomic broadcast). */
  deployResponse: DeployResponse;
}

export function formatSuccess(input: FormatSuccessInput): string {
  if (!UUID_RE.test(input.leaseUuid)) {
    throw new TypeError(
      `formatSuccess: leaseUuid must be a UUID; got "${input.leaseUuid}"`,
    );
  }
  if (
    input.deployResponse === null ||
    typeof input.deployResponse !== 'object'
  ) {
    throw new TypeError(
      'formatSuccess: deployResponse must be a non-null object',
    );
  }

  const dr = input.deployResponse;
  const providerName =
    typeof dr.provider_uuid === 'string' && dr.provider_uuid.length > 0
      ? dr.provider_uuid
      : '(unknown)';
  const stateName = decodeStateName(dr.state);
  const endpoints = extractRunningEndpoints(dr.connection);
  const ingresses = endpoints
    .map(formatEndpointAsIngress)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);

  const lines: string[] = [
    'Deployed.',
    `  Provider:      ${providerName}`,
    `  Lease UUID:    ${input.leaseUuid}`,
    `  Lease Status:  ${stateName}`,
  ];

  // Custom-domain block — chain tx confirmed, provider may still be
  // provisioning. Present BEFORE Ingress so the user sees the requested
  // endpoint first, alongside the immediately-working provider FQDN.
  if (typeof dr.custom_domain === 'string' && dr.custom_domain.length > 0) {
    lines.push(`  Custom domain (provisioning):  https://${dr.custom_domain}/`);
    lines.push(
      '    — TLS may take a few minutes; the Ingress URL below works immediately.',
    );
  }

  if (ingresses.length === 0) {
    lines.push(
      '  Ingress:       (none — service is internal or no FQDN reported)',
    );
  } else if (ingresses.length === 1) {
    lines.push(`  Ingress:       ${ingresses[0]}`);
  } else {
    lines.push('  Ingresses:');
    for (const fqdn of ingresses) {
      lines.push(`    - ${fqdn}`);
    }
  }
  lines.push('');
  lines.push(
    `For logs / status:  /manifest-agent:troubleshoot-deployment ${input.leaseUuid}`,
  );

  return lines.join('\n');
}

/**
 * Return the user-facing form of a lease state. The `LEASE_STATE_` prefix
 * is stripped for display (e.g. `LEASE_STATE_ACTIVE` → `ACTIVE`). Unknown
 * decodes render as `UNKNOWN(<raw>)` so the raw remains visible; absent
 * state renders as `(unknown)`.
 */
function decodeStateName(state: number | string | undefined): string {
  if (state === undefined) return '(unknown)';
  const canonical = decodeLeaseState(state);
  if (canonical !== undefined) {
    return canonical.slice('LEASE_STATE_'.length);
  }
  return `UNKNOWN(${String(state)})`;
}

// Re-export for callers that want to walk endpoints themselves without
// re-importing from `./connection.js`. Keeps `format-success.ts` the
// single consumer-facing entry for success-rendering plumbing.
export type { RunningEndpoint };
