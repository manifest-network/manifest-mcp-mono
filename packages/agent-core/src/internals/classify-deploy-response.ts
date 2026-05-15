import {
  extractRunningEndpoints,
  formatEndpointAsUrl,
  hasRunningInstances,
  normalizeFredUrl,
} from './connection.js';
import { decode as decodeLeaseState, isTerminal } from './lease-state.js';

/**
 * Classify the RETURN envelope of `mcp__manifest-fred__deploy_app` into one
 * of three outcomes for the orchestrator to branch on. 1:1 port of
 * `manifest-agent-plugin/scripts/classify-deploy-response.cjs`.
 *
 * Companion to `classify-deploy-error.ts` (which handles the THROW path).
 *
 * Outcomes:
 *   - `'active'`     — state is LEASE_STATE_ACTIVE AND at least one
 *                      running instance exists. Internal-only deploys
 *                      (every port `ingress: false`) have running
 *                      instances but no FQDN, so the URL count alone
 *                      can't gate this; `hasRunningInstances` covers it.
 *                      Orchestrator can skip `wait_for_app_ready`.
 *   - `'needs_wait'` — lease created but not yet active, OR no running
 *                      instances yet (provider hasn't started the
 *                      container). Orchestrator polls `wait_for_app_ready`.
 *   - `'failed'`     — no `lease_uuid` present, OR state is a terminal
 *                      failure state (CLOSED / REJECTED / EXPIRED, plus
 *                      the legacy INSUFFICIENT_FUNDS defense-in-depth).
 *                      Orchestrator routes to troubleshoot/cleanup.
 *
 * Terminal-state set is the union of `TERMINAL_STATES` from `lease-state.ts`
 * — extended from the CJS's `{CLOSED, INSUFFICIENT_FUNDS}` to also cover
 * `REJECTED` and `EXPIRED` since those are emitted by manifestjs 2.4.1
 * (chain v2.1.0) as terminal states. INSUFFICIENT_FUNDS is unreachable
 * from `decode()` on the current chain but retained as defense-in-depth.
 * See `lease-state.ts` for the divergence rationale.
 *
 * Error summary format (qa-engineer's parity pin):
 *   - Lease present + terminal: `Lease ${leaseUuid} reached terminal state ${stateName || 'UNKNOWN'}`
 *   - Lease missing: `deploy_app returned no lease_uuid`
 *   - `connectionError` string present: passed through verbatim
 */

export interface DeployResponseShape {
  lease_uuid?: unknown;
  provider_uuid?: unknown;
  provider_url?: unknown;
  state?: unknown;
  url?: unknown;
  connection?: unknown;
  connectionError?: unknown;
}

export interface DeployResponseClassification {
  outcome: 'active' | 'needs_wait' | 'failed';
  leaseUuid?: string;
  providerUuid?: string;
  providerUrl?: string;
  urls: string[];
  stateName?: string;
  errorSummary?: string;
}

export function classifyDeployResponse(
  response: DeployResponseShape,
): DeployResponseClassification {
  const stateName = decodeLeaseState(
    typeof response.state === 'number' || typeof response.state === 'string'
      ? response.state
      : undefined,
  );

  // URL synthesis from connection payload + optional top-level `url`.
  const urls: string[] = extractRunningEndpoints(response.connection).map(
    formatEndpointAsUrl,
  );
  if (typeof response.url === 'string' && response.url.length > 0) {
    const u = normalizeFredUrl(response.url);
    if (u.length > 0 && !urls.includes(u)) urls.unshift(u);
  }

  const leaseUuid =
    typeof response.lease_uuid === 'string' ? response.lease_uuid : undefined;

  let outcome: DeployResponseClassification['outcome'];
  if (!leaseUuid) {
    outcome = 'failed';
  } else if (
    stateName === 'LEASE_STATE_ACTIVE' &&
    (urls.length > 0 || hasRunningInstances(response.connection))
  ) {
    outcome = 'active';
  } else if (stateName !== undefined && isTerminal(stateName)) {
    outcome = 'failed';
  } else {
    // Pending / unspecified / active-without-any-running-instance / unknown.
    outcome = 'needs_wait';
  }

  const out: DeployResponseClassification = {
    outcome,
    ...(leaseUuid !== undefined && { leaseUuid }),
    ...(typeof response.provider_uuid === 'string' && {
      providerUuid: response.provider_uuid,
    }),
    ...(typeof response.provider_url === 'string' && {
      providerUrl: response.provider_url,
    }),
    urls,
    ...(stateName !== undefined && { stateName }),
  };

  if (outcome === 'failed') {
    if (typeof response.connectionError === 'string') {
      out.errorSummary = response.connectionError;
    } else if (!leaseUuid) {
      out.errorSummary = 'deploy_app returned no lease_uuid';
    } else {
      // Byte-exact format (qa-engineer's parity pin):
      // `Lease ${lease_uuid} reached terminal state ${stateName || 'UNKNOWN'}`
      out.errorSummary = `Lease ${leaseUuid} reached terminal state ${
        stateName || 'UNKNOWN'
      }`;
    }
  }

  return out;
}
