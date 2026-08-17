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
  abortableSleep,
  LeaseState,
  leaseStateFromJSON,
  logger,
} from '@manifest-network/manifest-mcp-core';
import { failureDetail } from '../failure-reason.js';
import {
  capProviderText,
  fetchJsonChecked,
  isTransientProviderError,
  PROVIDER_TEXT_EXCERPT_CHARS,
  ProviderApiError,
  validateProviderUrl,
} from './provider.js';

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
  const raw = await fetchJsonChecked<RawLeaseStatus>(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
      signal,
    },
    undefined,
    fetchFn,
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
  return await fetchJsonChecked<FredLeaseLogs>(
    url,
    { headers: { Authorization: `Bearer ${authToken}` } },
    undefined,
    fetchFn,
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
  return await fetchJsonChecked<FredLeaseProvision>(
    url,
    { headers: { Authorization: `Bearer ${authToken}` } },
    undefined,
    fetchFn,
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
  return await fetchJsonChecked<FredActionResponse>(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    },
    undefined,
    fetchFn,
  );
}

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
  return await fetchJsonChecked<FredActionResponse>(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: b64 }),
    },
    undefined,
    fetchFn,
  );
}

/**
 * Restore a closed lease's retained volumes onto a fresh PENDING lease (ENG-599).
 * `leaseUuid` is the NEW (fresh PENDING) lease; the body names the SOURCE retained
 * lease. Token must be scoped to the NEW lease. Returns 202 {status:"provisioning"};
 * fetchJsonChecked throws ProviderApiError for any non-2xx (404 not-retained, 409 not
 * PENDING, 422 demote, 503 placement, …) — the tool layer classifies by `.status`.
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
  return await fetchJsonChecked<FredActionResponse>(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from_lease_uuid: fromLeaseUuid }),
    },
    undefined,
    fetchFn,
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
  return await fetchJsonChecked<FredLeaseReleases>(
    url,
    { headers: { Authorization: `Bearer ${authToken}` } },
    undefined,
    fetchFn,
  );
}

export type TerminalChainLeaseState = 'closed' | 'rejected' | 'expired';

export interface TerminalChainState {
  readonly state: TerminalChainLeaseState;
}

export interface PollOptions {
  readonly intervalMs?: number;
  /** Overall deadline. Defaults to {@link DEFAULT_POLL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (status: FredLeaseStatus) => void;
  /** Runs once per iteration before the provider is queried. Non-null return throws; errors propagate. */
  readonly checkChainState?: () => Promise<TerminalChainState | null>;
  /**
   * How many CONSECUTIVE provider status-read failures to tolerate before
   * giving up. Default 3; `0` restores the pre-ENG-661 behaviour of failing on
   * the first blip. The counter resets to 0 on every successful read, so this
   * is a burst tolerance, not a lifetime allowance.
   *
   * It can never extend the poll past `timeoutMs` — the deadline still bounds
   * the whole loop. Only the status READ is covered: a terminal lease state, a
   * failed `provision_status`, a `checkChainState` verdict, an auth-token
   * failure and a caller abort all propagate immediately and are never counted.
   * (ENG-479, ENG-661)
   */
  readonly maxConsecutiveFailures?: number;
}

const CHAIN_STATE_TO_LEASE_STATE: Record<TerminalChainLeaseState, LeaseState> =
  {
    closed: LeaseState.LEASE_STATE_CLOSED,
    rejected: LeaseState.LEASE_STATE_REJECTED,
    expired: LeaseState.LEASE_STATE_EXPIRED,
  };

function leaseStateName(state: LeaseState): string {
  return LeaseState[state] ?? String(state);
}

/**
 * Provider `provision_status` values (fred backend `ProvisionStatus`) that mean
 * the lease is not yet confirmed healthy while the chain lease is already
 * ACTIVE — keep polling. `failing` is the pre-terminal window before `failed`
 * (the backend state machine only ever moves `failing → failed`, never back to
 * provisioning, so waiting is bounded). `unknown` is the backend's indeterminate
 * signal — an unrecognized container status or a state-machine read error — and
 * likewise is "not confirmed ready", so we wait for it to settle to
 * `ready`/`failed` rather than reporting it as success. A status string this
 * client does not recognize at all (a genuinely future value) is NOT listed
 * here; the ACTIVE branch treats it as settled (see below).
 */
export const PROVISION_IN_PROGRESS: ReadonlySet<string> = new Set([
  'provisioning',
  'restarting',
  'updating',
  'failing',
  'unknown',
]);

/**
 * Provider `provision_status` values that mean provisioning will not become
 * healthy. The chain lease is ACTIVE, but the deployment has effectively failed
 * (or is being torn down) — surface it as an error instead of a ready lease.
 */
export const PROVISION_FAILED: ReadonlySet<string> = new Set([
  'failed',
  'deprovisioning',
]);

/**
 * The provider `provision_status` values that mean the deployment is CONFIRMED
 * HEALTHY. Success is an allowlist, not a fall-through: a status this client
 * does not recognize is "not confirmed ready", never "ready".
 *
 * WHY THIS EXISTS (ENG-651). The ACTIVE branch used to answer `ready` for any
 * status outside the two sets above, documented as forward-compat. That reads
 * one ecosystem rule — never *fail* on an unknown enum value (Smithy: clients
 * "MUST NOT fail when they encounter an unknown enum value") — as licence for a
 * different one: never *distrust* an unknown value. Nothing supports the second.
 * Google's AIP-216 describes this exact defect in its breaking-changes section,
 * and states plainly that adding a new state is not a breaking change, so new
 * values WILL arrive. Kubernetes says "nothing should be assumed about Pods that
 * have a given phase value"; Argo CD sorts Unknown BELOW Degraded; Nagios has
 * reserved exit-3 for UNKNOWN for 25 years.
 *
 * It cost us a real bug. Fred's `retained` — the backend tore the deployment
 * down but kept its volumes — was in neither set, so a closed, soft-deleted,
 * billing-dead lease resolved as a successful deploy. Note the inconsistency it
 * created: the backend's own `unknown` ("I cannot tell") is in
 * PROVISION_IN_PROGRESS and correctly keeps polling, while a status the CLIENT
 * cannot recognize was luckier and got reported as healthy.
 *
 * An absent `provision_status` still means success — that is a legacy provider
 * which never populates the field, not an unrecognized value.
 */
export const PROVISION_SUCCESS: ReadonlySet<string> = new Set(['ready']);

/**
 * Statuses this client KNOWS about that are none of ready / in-progress /
 * failed. `retained` is the only one: the backend tore the deployment down but
 * kept its volumes. On a CLOSED lease the chain-state branch has already decided
 * it is terminal; on an ACTIVE one it is an anomaly the provider's reconciler
 * re-provisions, so the wait continues. Either way it is NOT unrecognized — it
 * is listed here so the "your provider may be newer than this client" warning
 * below stays true, and does not fire for the one value we model deliberately.
 */
const PROVISION_KNOWN_NOT_READY: ReadonlySet<string> = new Set(['retained']);

/** Values already reported, so a 3s poll loop reports a novel status once per
 *  process rather than on every tick. */
const warnedProvisionStatuses = new Set<string>();

/**
 * Report a `provision_status` that appears in NONE of this client's sets. That
 * is the audit signal for the fail-closed default: the value is carried through
 * unchanged and treated as not-yet-ready, and an operator gets told which
 * unmodelled value the fleet is emitting so the sets can be updated
 * deliberately. A status we do model is not reported — silence here means
 * "handled", not "unnoticed".
 */
export function warnIfUnrecognizedProvisionStatus(
  provisionStatus: string,
  leaseUuid?: string,
): void {
  if (
    PROVISION_SUCCESS.has(provisionStatus) ||
    PROVISION_FAILED.has(provisionStatus) ||
    PROVISION_IN_PROGRESS.has(provisionStatus) ||
    PROVISION_KNOWN_NOT_READY.has(provisionStatus)
  ) {
    return;
  }
  if (warnedProvisionStatuses.has(provisionStatus)) return;
  warnedProvisionStatuses.add(provisionStatus);
  logger.warn(
    `[fred] Unrecognized provision_status "${provisionStatus}"${
      leaseUuid !== undefined ? ` (first seen on lease ${leaseUuid})` : ''
    }. Treating it as not-yet-ready rather than ready — the provider may be running a newer ` +
      'version than this client supports.',
  );
}

/**
 * Thrown by pollLeaseUntilReady when the caller's checkChainState callback
 * reports a terminal lease state on-chain. Extends ProviderApiError so
 * existing catchers keep working; use `instanceof TerminalChainStateError`
 * or read `chainState` to distinguish from provider-reported terminal states.
 */
export interface TerminalChainStateContext {
  readonly lease_uuid?: string;
  readonly providerUuid?: string;
  readonly providerUrl?: string;
}

export class TerminalChainStateError extends ProviderApiError {
  public readonly chainState: TerminalChainLeaseState;
  public readonly leaseUuid: string;
  public readonly providerUuid?: string;
  public readonly providerUrl?: string;
  /**
   * Structured context for downstream classifiers (e.g. agent-core's
   * classify-deploy-error). `lease_uuid` is always present so callers can name
   * the affected lease without re-deriving it from the message; provider keys
   * appear once `withContext` enriches the error.
   */
  public readonly details: {
    readonly lease_uuid: string;
    readonly provider_uuid?: string;
    readonly provider_url?: string;
  };

  constructor(
    leaseUuid: string,
    chainState: TerminalChainLeaseState,
    context?: TerminalChainStateContext,
  ) {
    const mapped = CHAIN_STATE_TO_LEASE_STATE[chainState];
    super(
      0,
      `Lease ${leaseUuid} entered terminal state ${leaseStateName(mapped)} on chain`,
    );
    this.name = 'TerminalChainStateError';
    this.chainState = chainState;
    this.leaseUuid = leaseUuid;
    this.providerUuid = context?.providerUuid;
    this.providerUrl = context?.providerUrl;
    this.details = {
      lease_uuid: context?.lease_uuid ?? leaseUuid,
      provider_uuid: context?.providerUuid,
      provider_url: context?.providerUrl,
    };
    Object.setPrototypeOf(this, TerminalChainStateError.prototype);
  }

  /**
   * Returns a new instance with the same lease/state and the supplied context,
   * preserving the original stack trace so debugging points to where the
   * terminal state was first detected.
   */
  withContext(context: TerminalChainStateContext): TerminalChainStateError {
    const enriched = new TerminalChainStateError(
      this.leaseUuid,
      this.chainState,
      context,
    );
    if (this.stack) enriched.stack = this.stack;
    return enriched;
  }
}

/** Why the poll stopped without ever learning whether the deployment is healthy. */
export type ReadinessUnconfirmedReason = 'deadline' | 'provider_unreachable';

export interface LeaseReadinessUnconfirmedInput {
  readonly leaseUuid: string;
  readonly reason: ReadinessUnconfirmedReason;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly lastState?: LeaseState;
  readonly lastProvisionStatus?: string;
  readonly consecutiveFailures?: number;
  readonly lastPollError?: unknown;
  readonly context?: TerminalChainStateContext;
}

/**
 * A nested error's text, for EMBEDDING in composed prose.
 *
 * Capped tighter than the outer `MAX_PROVIDER_ERROR_CHARS`, and not redundant with it:
 * `readinessUnconfirmedMessage` puts this excerpt in the MIDDLE, followed by the
 * load-bearing "NOT a reported failure … re-check with app_status" sentence. With only
 * the outer cap, a 4096-char nested error would push that sentence past it and delete
 * the very guidance ENG-661 exists to deliver (ENG-669).
 */
function errorText(err: unknown): string {
  return capProviderText(
    err instanceof Error ? err.message : String(err),
    PROVIDER_TEXT_EXCERPT_CHARS,
  );
}

function readinessUnconfirmedMessage(
  input: LeaseReadinessUnconfirmedInput,
): string {
  const where = `last state: ${
    input.lastState !== undefined ? leaseStateName(input.lastState) : 'unknown'
  }, provision_status: ${input.lastProvisionStatus ?? 'unknown'}`;
  // "NOT a reported failure" is the load-bearing sentence: this message reaches
  // an agent verbatim through wait_for_app_ready / restart_app / update_app,
  // because withErrorHandling only attaches code+details for ManifestMCPError.
  if (input.reason === 'provider_unreachable') {
    return (
      `Lease ${input.leaseUuid} poll gave up after ${input.consecutiveFailures ?? 0} consecutive ` +
      `failed status reads over ${input.elapsedMs}ms (${where}; last error: ${errorText(input.lastPollError)}). ` +
      'This is NOT a reported failure: the provider never returned a failed provision_status — its ' +
      'status endpoint was unreachable from here. The deployment may be healthy; re-check with ' +
      'app_status before treating it as failed.'
    );
  }
  return (
    `Lease ${input.leaseUuid} poll timed out after ${input.timeoutMs}ms without a verdict from the ` +
    `provider (${where}). This is NOT a reported failure: the provider never returned a failed ` +
    'provision_status, and a cold image pull alone can take 5 minutes. The deployment may still be ' +
    'coming up — re-check with app_status, or wait again with a longer timeout, before treating it ' +
    'as failed.' +
    (input.lastPollError !== undefined
      ? ` The last status read also failed with: ${errorText(input.lastPollError)}.`
      : '')
  );
}

/**
 * The poll ended WITHOUT a verdict from the provider — the deadline expired, or
 * its status endpoint stayed unreachable past the consecutive-failure budget.
 *
 * This is the ENG-661 discriminant, and the distinction it draws is the whole
 * point: "we never found out" is not "it failed". The provider never reported a
 * failed `provision_status` and the chain never cleared the lease, so the lease
 * is LIVE and may well be healthy — a caller must not treat this as licence to
 * close it. `PROVISION_FAILED` and terminal lease states keep throwing a plain
 * `ProviderApiError`; only genuine silence lands here.
 *
 * Extends `ProviderApiError` (as `TerminalChainStateError` does) so existing
 * catchers keep working and the dual-package `Symbol.for` brand is inherited;
 * use `instanceof` or read `reason` to discriminate.
 */
export class LeaseReadinessUnconfirmedError extends ProviderApiError {
  public readonly reason: ReadinessUnconfirmedReason;
  public readonly leaseUuid: string;
  public readonly lastState?: LeaseState;
  public readonly lastProvisionStatus?: string;
  public readonly timeoutMs: number;
  public readonly elapsedMs: number;
  public readonly consecutiveFailures?: number;
  /** Structured context for downstream classifiers (agent-core's classify-deploy-error). */
  public readonly details: {
    readonly lease_uuid: string;
    readonly provider_uuid?: string;
    readonly provider_url?: string;
    readonly reason: ReadinessUnconfirmedReason;
    readonly last_state?: string;
    readonly last_provision_status?: string;
    readonly timeout_ms: number;
    readonly elapsed_ms: number;
  };
  private readonly input: LeaseReadinessUnconfirmedInput;

  constructor(input: LeaseReadinessUnconfirmedInput) {
    super(0, readinessUnconfirmedMessage(input), {
      kind: 'poll',
      ...(input.lastPollError !== undefined && { cause: input.lastPollError }),
    });
    this.name = 'LeaseReadinessUnconfirmedError';
    this.input = input;
    this.reason = input.reason;
    this.leaseUuid = input.leaseUuid;
    this.lastState = input.lastState;
    this.lastProvisionStatus = input.lastProvisionStatus;
    this.timeoutMs = input.timeoutMs;
    this.elapsedMs = input.elapsedMs;
    this.consecutiveFailures = input.consecutiveFailures;
    this.details = {
      lease_uuid: input.context?.lease_uuid ?? input.leaseUuid,
      provider_uuid: input.context?.providerUuid,
      provider_url: input.context?.providerUrl,
      reason: input.reason,
      last_state:
        input.lastState !== undefined
          ? leaseStateName(input.lastState)
          : undefined,
      last_provision_status: input.lastProvisionStatus,
      timeout_ms: input.timeoutMs,
      elapsed_ms: input.elapsedMs,
    };
    Object.setPrototypeOf(this, LeaseReadinessUnconfirmedError.prototype);
  }

  /**
   * Returns a new instance carrying the supplied provider context, preserving
   * the original stack so debugging points at the poll, not the enricher.
   * Mirrors `TerminalChainStateError.withContext`.
   */
  withContext(
    context: TerminalChainStateContext,
  ): LeaseReadinessUnconfirmedError {
    const enriched = new LeaseReadinessUnconfirmedError({
      ...this.input,
      context,
    });
    if (this.stack) enriched.stack = this.stack;
    return enriched;
  }
}

/**
 * Sleep for `ms`, abort-aware — re-exported from core, which owns it since ENG-710 (it needs the
 * same primitive for the cancellable rate-limit wait, and this copy had inlined a second, drifting
 * spelling of core's `abortReason` fallback). Kept on this module's surface so the lease-status
 * watchers (`waitForLeaseStatus`) keep importing it from here.
 *
 * Two behaviour deltas from the copy this replaces, both deliberate: a pre-aborted signal now
 * rejects the returned promise instead of throwing SYNCHRONOUSLY out of a promise-returning
 * function (every call site awaits it, so the await point is unchanged), and a `null` abort reason
 * is normalized to the spec's `AbortError` on the pre-abort leg too — the old `throwIfAborted()`
 * rethrew it raw while the listener leg already replaced it.
 */
export { abortableSleep };

/**
 * How long a provider may take to make a deployment ready before we stop
 * waiting. 10 minutes, because that is what Fred's docker backend actually
 * allows itself: `ProvisionTimeout: 10 * time.Minute`, of which
 * `ImagePullTimeout` alone is `5 * time.Minute`
 * (submodules/fred/internal/backend/docker/config.go).
 *
 * The previous 120s default was ~5x short of that, so any cold image pull past
 * ~2 minutes tripped the deadline on a perfectly healthy lease — and the deploy
 * path then reported that as a failure and recommended closing the lease
 * (ENG-661). A client deadline shorter than the server's own means the client
 * gives up before the server has a verdict to give.
 */
export const DEFAULT_POLL_TIMEOUT_MS = 600_000;

/** Default consecutive-failure tolerance for the status read (ENG-479). */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/** Ceiling on how long a provider-supplied `Retry-After` may park the poll. Fred
 *  caps its own header at 86400s; honouring that literally would hand a single
 *  response the entire budget, so we honour the hint but bound it. */
const MAX_RETRY_AFTER_HONOURED_MS = 30_000;

export async function pollLeaseUntilReady(
  providerUrl: string,
  leaseUuid: string,
  authToken: string | (() => Promise<string>),
  opts: PollOptions = {},
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<FredLeaseStatus> {
  const {
    intervalMs = 3_000,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    abortSignal,
    onProgress,
    checkChainState,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  } = opts;
  // Clamp rather than throw: a nonsensical knob should not abort a deploy that
  // is otherwise fine.
  const failureBudget = Math.max(0, Math.floor(maxConsecutiveFailures));
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastState: LeaseState | undefined;
  let lastProvisionStatus: string | undefined;
  let consecutiveFailures = 0;
  let lastPollError: unknown;

  while (Date.now() < deadline) {
    abortSignal?.throwIfAborted();
    if (checkChainState) {
      const chainState = await checkChainState();
      if (chainState) {
        throw new TerminalChainStateError(leaseUuid, chainState.state);
      }
      abortSignal?.throwIfAborted();
    }
    const token =
      typeof authToken === 'function' ? await authToken() : authToken;
    abortSignal?.throwIfAborted();
    // ONLY the status read is inside this try (ENG-479/ENG-661). Everything that
    // constitutes a VERDICT — the chain-state check above, the token mint, and
    // the whole state switch below (PROVISION_FAILED, terminal lease states, an
    // unexpected state) — is deliberately outside it, so no future edit can make
    // the failure budget swallow a real answer. A blip is worth another look; a
    // verdict is not.
    let status: FredLeaseStatus;
    try {
      status = await getLeaseStatus(
        providerUrl,
        leaseUuid,
        token,
        fetchFn,
        abortSignal,
        allowLoopback,
      );
    } catch (err) {
      // Cancellation first, and keyed on the SIGNAL rather than the error shape:
      // checkedFetch rethrows the caller's own abort reason verbatim, which can
      // be any value. A user's cancel is never a transient fault.
      abortSignal?.throwIfAborted();
      // A 404 is tolerated HERE although `isTransientProviderError` rejects it
      // globally. Right after create-lease the provider may still be ingesting
      // the lease, so its `/status` can 404 for a beat — the window ENG-479 was
      // filed for, and the one barney's pre-migration poll tolerated. The
      // tolerance is scoped to this loop deliberately: a 404 from any other
      // provider call is still a hard error, and here it is bounded by the same
      // consecutive-failure budget, so a lease the provider genuinely does not
      // know about still fails after `maxConsecutiveFailures` reads.
      const tolerable =
        isTransientProviderError(err) ||
        (ProviderApiError.isProviderApiError(err) && err.status === 404);
      if (!tolerable) throw err;
      consecutiveFailures += 1;
      lastPollError = err;
      if (consecutiveFailures > failureBudget) {
        throw new LeaseReadinessUnconfirmedError({
          leaseUuid,
          reason: 'provider_unreachable',
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          lastState,
          lastProvisionStatus,
          consecutiveFailures,
          lastPollError: err,
        });
      }
      logger.warn(
        `[fred] lease ${leaseUuid} status read failed (${consecutiveFailures}/${failureBudget} tolerated): ${errorText(err)}`,
      );
      // Honour the provider's own Retry-After when it sent one, bounded by our
      // ceiling and by the remaining deadline. A wait clamped to 0 means the
      // deadline has passed, and the loop guard turns that into the deadline
      // error on the next pass rather than a hot retry loop.
      const retryAfterMs = ProviderApiError.isProviderApiError(err)
        ? err.retryAfterMs
        : undefined;
      const wait = Math.max(
        0,
        Math.min(
          retryAfterMs ?? intervalMs,
          MAX_RETRY_AFTER_HONOURED_MS,
          deadline - Date.now(),
        ),
      );
      await abortableSleep(wait, abortSignal);
      continue;
    }
    consecutiveFailures = 0;
    lastPollError = undefined;
    lastState = status.state;
    lastProvisionStatus = status.provision_status;
    onProgress?.(status);
    switch (status.state) {
      case LeaseState.LEASE_STATE_ACTIVE: {
        // The chain lease is ACTIVE, but the provider may still be pulling the
        // image / starting the container — or the container may have crashed.
        // Gate readiness on provision_status so callers never observe a lease as
        // ready mid-provision. Readiness is an ALLOWLIST (PROVISION_SUCCESS):
        // an unrecognized status keeps polling rather than reporting ready, so a
        // value added by a newer provider cannot be mistaken for health
        // (ENG-651 — see PROVISION_SUCCESS for why the default inverted). An
        // ABSENT field still returns, preserving the original ACTIVE-returns
        // behavior for providers that don't populate it at all.
        //
        // Readiness is decided by state + provision_status ONLY, never by the
        // presence of `reason`: Fred retains the failure attribution on a
        // healthy `ready` lease whose last update rolled back, so treating a
        // non-empty reason as a failure would strand every such lease (ENG-638).
        const ps = status.provision_status;
        if (ps !== undefined) {
          if (PROVISION_FAILED.has(ps)) {
            // ENG-638: prefer ENG-508's reason/message, fall back to the
            // deprecated last_error a pre-ENG-508 provider still sends. This
            // message is the only wire carrying Fred failure detail into
            // agent-core (deploy-app.ts stringifies err.message), so it has to
            // stay informative for BOTH shapes.
            const detail = failureDetail(status);
            throw new ProviderApiError(
              0,
              `Lease ${leaseUuid} is ACTIVE but provisioning ${ps}${
                detail ? `: ${detail}` : ''
              }`,
              { kind: 'poll_verdict' },
            );
          }
          if (!PROVISION_SUCCESS.has(ps)) {
            // In-progress, retained, or a value this client has never heard of.
            // None is CONFIRMED healthy, so keep polling: it either settles into
            // a status we do recognize, or the caller's deadline expires with an
            // error naming the last status seen. Both are honest; reporting it
            // as a ready deploy is not. (ENG-651)
            warnIfUnrecognizedProvisionStatus(ps, leaseUuid);
            break;
          }
        }
        return status;
      }
      case LeaseState.LEASE_STATE_PENDING:
        break;
      case LeaseState.LEASE_STATE_CLOSED:
      case LeaseState.LEASE_STATE_REJECTED:
      case LeaseState.LEASE_STATE_EXPIRED:
        throw new ProviderApiError(
          0,
          `Lease ${leaseUuid} entered terminal state ${leaseStateName(status.state)}`,
          { kind: 'poll_verdict' },
        );
      default:
        throw new ProviderApiError(
          0,
          `Lease ${leaseUuid} returned unexpected state ${leaseStateName(status.state)}`,
          { kind: 'poll_verdict' },
        );
    }
    await abortableSleep(intervalMs, abortSignal);
  }

  throw new LeaseReadinessUnconfirmedError({
    leaseUuid,
    reason: 'deadline',
    timeoutMs,
    elapsedMs: Date.now() - startedAt,
    lastState,
    lastProvisionStatus,
    ...(lastPollError !== undefined && { lastPollError }),
  });
}
