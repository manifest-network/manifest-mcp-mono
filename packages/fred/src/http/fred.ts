import { toBase64 } from '@cosmjs/encoding';
import type {
  FredActionResponse,
  FredInstanceInfo,
  FredLeaseLogs,
  FredLeaseProvision,
  FredLeaseRelease,
  FredLeaseReleases,
  FredLeaseStatus,
  FredServiceStatus,
} from '@manifest-network/manifest-mcp-core';
import {
  LeaseState,
  leaseStateFromJSON,
  logger,
} from '@manifest-network/manifest-mcp-core';
import {
  type LeaseStatusReader,
  type PollOptions,
  pollLeaseReadiness,
} from '../readiness/poll-lease-readiness.js';
import { fetchJsonChecked, validateProviderUrl } from './provider.js';
import {
  FredActionResponseSchema,
  FredLeaseLogsResponseSchema,
  FredLeaseProvisionResponseSchema,
  FredLeaseReleasesResponseSchema,
  RawLeaseStatusResponseSchema,
} from './response-schemas.js';

// The lease-readiness POLICY — the wait loop, the `provision_status` sets, and the two typed
// readiness errors — moved to `../readiness/poll-lease-readiness.js` in ENG-725. Re-exported here
// so `./http/fred.js` remains a stable import path for the fred barrel, the SDK `/deploy` subpath
// and existing consumers; the public names are unchanged.
//
// The edge runs ONE way — this module imports the readiness module, never the reverse — so there
// is no cycle. (`.dependency-cruiser.cjs` has no `no-circular` rule, so that is a claim worth
// stating rather than assuming.)
export {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_POLL_TIMEOUT_MS,
  LeaseReadinessUnconfirmedError,
  type LeaseReadinessUnconfirmedInput,
  type LeaseStatusReader,
  type PollLeaseInput,
  type PollOptions,
  PROVISION_FAILED,
  PROVISION_IN_PROGRESS,
  PROVISION_SUCCESS,
  pollLeaseReadiness,
  type ReadinessUnconfirmedReason,
  type TerminalChainLeaseState,
  type TerminalChainState,
  type TerminalChainStateContext,
  TerminalChainStateError,
  warnIfUnrecognizedProvisionStatus,
} from '../readiness/poll-lease-readiness.js';

export type {
  FredActionResponse,
  FredInstanceInfo,
  FredLeaseLogs,
  FredLeaseProvision,
  FredLeaseRelease,
  FredLeaseReleases,
  FredLeaseStatus,
  FredServiceStatus,
};

export const MAX_TAIL = 1000;

/** Raw wire shape before LeaseState conversion */
interface RawLeaseStatus extends Omit<FredLeaseStatus, 'state'> {
  readonly state: string;
}

export async function getLeaseStatus(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
  signal?: AbortSignal,
  allowLoopback = false,
): Promise<FredLeaseStatus> {
  const validated = validateProviderUrl(providerUrl, { allowLoopback });
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/status`;
  const raw: RawLeaseStatus = await fetchJsonChecked(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
      signal,
    },
    { schema: RawLeaseStatusResponseSchema, fetchFn },
  );
  const state = leaseStateFromJSON(raw.state);
  if (state === LeaseState.UNRECOGNIZED) {
    logger.warn(
      `[getLeaseStatus] Unrecognized lease state "${raw.state}" for lease ${leaseUuid}. ` +
        'The provider may be running a newer version than the client supports.',
    );
  }
  return { ...raw, state };
}

export async function getLeaseLogs(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  tail?: number,
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<FredLeaseLogs> {
  const validated = validateProviderUrl(providerUrl, { allowLoopback });
  const cappedTail = tail !== undefined ? Math.min(tail, MAX_TAIL) : undefined;
  const qs = cappedTail !== undefined ? `?tail=${cappedTail}` : '';
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/logs${qs}`;
  return await fetchJsonChecked(
    url,
    { headers: { Authorization: `Bearer ${authToken}` } },
    { schema: FredLeaseLogsResponseSchema, fetchFn },
  );
}

export async function getLeaseProvision(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<FredLeaseProvision> {
  const validated = validateProviderUrl(providerUrl, { allowLoopback });
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/provision`;
  return await fetchJsonChecked(
    url,
    { headers: { Authorization: `Bearer ${authToken}` } },
    { schema: FredLeaseProvisionResponseSchema, fetchFn },
  );
}

export async function restartLease(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<FredActionResponse> {
  const validated = validateProviderUrl(providerUrl, { allowLoopback });
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/restart`;
  return await fetchJsonChecked(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    },
    { schema: FredActionResponseSchema, fetchFn },
  );
}

/**
 * Replace a running lease's deployment manifest.
 *
 * Answers 202 `{status:"updating"}` on acceptance. Since Fred ENG-619 the payload is
 * also PERSISTED to the provider's payload store after the backend accepts it — which
 * is what stops the next reprovision reverting the tenant to the as-created manifest —
 * and a persist failure answers **500** where the old build answered a misleading 202.
 * A 5xx therefore does NOT establish that the update was rejected; `updateApp` turns it
 * into `UPDATE_INDETERMINATE` rather than a flat failure. A provider running with no
 * payload store configured now refuses `/update` outright.
 *
 * `payload` is sent base64-encoded inside JSON because the Go field is a `[]byte`.
 * The `payload_hash` field in Fred's backend contract is fred→backend only — a tenant
 * must not send one.
 */
export async function updateLease(
  providerUrl: string,
  leaseUuid: string,
  payload: Uint8Array,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<FredActionResponse> {
  const validated = validateProviderUrl(providerUrl, { allowLoopback });
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/update`;
  // The provider expects JSON with a base64-encoded payload (Go []byte field).
  const b64 = toBase64(payload);
  return await fetchJsonChecked(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: b64 }),
    },
    { schema: FredActionResponseSchema, fetchFn },
  );
}

/**
 * Restore a closed lease's retained volumes onto a fresh PENDING lease (ENG-599).
 * `leaseUuid` is the NEW (fresh PENDING) lease; the body names the SOURCE retained
 * lease. Token must be scoped to the NEW lease. Returns 202 {status:"provisioning"};
 * fetchJsonChecked throws ProviderApiError for any non-2xx — the tool layer classifies
 * by `.status`, and `restoreApp.ts` owns that table (which statuses are safe to
 * compensate). Fred's answer space here: 404 not-retained, 409 not PENDING or already
 * provisioned, 422 demote-exceeds-tier OR any other refusal code the backend authored
 * (widened in ENG-620 — a 422 no longer implies "demote"), 429 throttled, 502 the
 * backend's error body was off-contract (ENG-620/ENG-739), 503 placement unresolvable.
 * Not exhaustive by construction: treat an unlisted status as in-doubt, not as terminal.
 */
export async function restoreLease(
  providerUrl: string,
  leaseUuid: string,
  fromLeaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<FredActionResponse> {
  const validated = validateProviderUrl(providerUrl, { allowLoopback });
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/restore`;
  return await fetchJsonChecked(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from_lease_uuid: fromLeaseUuid }),
    },
    { schema: FredActionResponseSchema, fetchFn },
  );
}

export async function getLeaseReleases(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<FredLeaseReleases> {
  const validated = validateProviderUrl(providerUrl, { allowLoopback });
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/releases`;
  return await fetchJsonChecked(
    url,
    { headers: { Authorization: `Bearer ${authToken}` } },
    { schema: FredLeaseReleasesResponseSchema, fetchFn },
  );
}

/**
 * Wait until a lease is ready. Transport-bound entry point to
 * {@link pollLeaseReadiness}, which owns the policy.
 *
 * The signature is unchanged from before ENG-725 and stays that way: it is on the fred barrel and
 * the SDK `/deploy` subpath, and `agent-core/src/deploy-app.ts` calls it positionally. Prefer
 * `pollLeaseReadiness` in new code — it takes the status read as a parameter, so a caller that
 * already has a transport (or a test that wants to script statuses) does not go through this
 * URL-and-fetch shaped door.
 *
 * The closure below IS the edge ENG-716 named: a call to this module's own `getLeaseStatus`, which
 * no `vi.mock('./fred.js')` can intercept because vitest does not rewrite intra-module references.
 * It is now four visible lines on the LEGACY path only — every caller that injects its own reader
 * bypasses it entirely — and `fred.test.ts` drives it deliberately through an injected `fetchFn`,
 * which is what keeps it covered rather than merely contained.
 */
export async function pollLeaseUntilReady(
  providerUrl: string,
  leaseUuid: string,
  authToken: string | (() => Promise<string>),
  opts: PollOptions = {},
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<FredLeaseStatus> {
  const read: LeaseStatusReader = ({ token, signal }) =>
    getLeaseStatus(
      providerUrl,
      leaseUuid,
      token,
      fetchFn,
      signal,
      allowLoopback,
    );
  const mintToken =
    typeof authToken === 'function'
      ? authToken
      : async (): Promise<string> => authToken;
  return await pollLeaseReadiness(read, { leaseUuid, mintToken }, opts);
}
