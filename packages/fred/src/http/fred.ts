import { toBase64 } from '@cosmjs/encoding';
import type {
  FredActionResponse,
  FredInstanceInfo,
  FredLeaseInfo,
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
  checkedFetch,
  ProviderApiError,
  parseJsonResponse,
  validateProviderUrl,
} from './provider.js';

export type {
  FredActionResponse,
  FredInstanceInfo,
  FredLeaseInfo,
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
): Promise<FredLeaseStatus> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/status`;
  const res = await checkedFetch(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
      signal,
    },
    undefined,
    fetchFn,
  );
  const raw = await parseJsonResponse<RawLeaseStatus>(res, url);
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
): Promise<FredLeaseLogs> {
  const validated = validateProviderUrl(providerUrl);
  const cappedTail = tail !== undefined ? Math.min(tail, MAX_TAIL) : undefined;
  const qs = cappedTail !== undefined ? `?tail=${cappedTail}` : '';
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/logs${qs}`;
  const res = await checkedFetch(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
    },
    undefined,
    fetchFn,
  );
  return await parseJsonResponse<FredLeaseLogs>(res, url);
}

export async function getLeaseProvision(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredLeaseProvision> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/provision`;
  const res = await checkedFetch(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
    },
    undefined,
    fetchFn,
  );
  return await parseJsonResponse<FredLeaseProvision>(res, url);
}

export async function restartLease(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredActionResponse> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/restart`;
  const res = await checkedFetch(
    url,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    },
    undefined,
    fetchFn,
  );
  return await parseJsonResponse<FredActionResponse>(res, url);
}

export async function updateLease(
  providerUrl: string,
  leaseUuid: string,
  payload: Uint8Array,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredActionResponse> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/update`;
  // The provider expects JSON with a base64-encoded payload (Go []byte field).
  const b64 = toBase64(payload);
  const res = await checkedFetch(
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
  return await parseJsonResponse<FredActionResponse>(res, url);
}

export async function getLeaseReleases(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredLeaseReleases> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/releases`;
  const res = await checkedFetch(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
    },
    undefined,
    fetchFn,
  );
  return await parseJsonResponse<FredLeaseReleases>(res, url);
}

export async function getLeaseInfo(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredLeaseInfo> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/info`;
  const res = await checkedFetch(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
    },
    undefined,
    fetchFn,
  );
  return await parseJsonResponse<FredLeaseInfo>(res, url);
}

export type TerminalChainLeaseState = 'closed' | 'rejected' | 'expired';

export interface TerminalChainState {
  readonly state: TerminalChainLeaseState;
}

export interface PollOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (status: FredLeaseStatus) => void;
  /** Runs once per iteration before the provider is queried. Non-null return throws; errors propagate. */
  readonly checkChainState?: () => Promise<TerminalChainState | null>;
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

/**
 * Sleep for `ms`, abort-aware. With no `signal` it is a plain `setTimeout` sleep; with one it clears
 * the timer and rejects with `signal.reason ?? AbortError` if the signal aborts before the sleep ends
 * (pre-aborted signals reject synchronously via `throwIfAborted`). Exported for the lease-status
 * watchers (`waitForLeaseStatus`) so the interval wait cancels on caller abort.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason ??
          new DOMException('The operation was aborted', 'AbortError'),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollLeaseUntilReady(
  providerUrl: string,
  leaseUuid: string,
  authToken: string | (() => Promise<string>),
  opts: PollOptions = {},
  fetchFn?: typeof globalThis.fetch,
): Promise<FredLeaseStatus> {
  const {
    intervalMs = 3_000,
    timeoutMs = 120_000,
    abortSignal,
    onProgress,
    checkChainState,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastState: LeaseState | undefined;
  let lastProvisionStatus: string | undefined;

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
    const status = await getLeaseStatus(providerUrl, leaseUuid, token, fetchFn);
    lastState = status.state;
    lastProvisionStatus = status.provision_status;
    onProgress?.(status);
    switch (status.state) {
      case LeaseState.LEASE_STATE_ACTIVE: {
        // The chain lease is ACTIVE, but the provider may still be pulling the
        // image / starting the container — or the container may have crashed.
        // Gate readiness on provision_status so callers never observe a lease as
        // ready mid-provision. An absent field, or a status string this client
        // does not recognize (a future value), is treated as settled —
        // forward-compat, and it preserves the original ACTIVE-returns behavior
        // for providers that don't populate the field.
        const ps = status.provision_status;
        if (ps !== undefined) {
          if (PROVISION_FAILED.has(ps)) {
            throw new ProviderApiError(
              0,
              `Lease ${leaseUuid} is ACTIVE but provisioning ${ps}${
                status.last_error ? `: ${status.last_error}` : ''
              }`,
            );
          }
          if (PROVISION_IN_PROGRESS.has(ps)) {
            break; // still provisioning — keep polling
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
        );
      default:
        throw new ProviderApiError(
          0,
          `Lease ${leaseUuid} returned unexpected state ${leaseStateName(status.state)}`,
        );
    }
    await abortableSleep(intervalMs, abortSignal);
  }

  throw new ProviderApiError(
    0,
    `Lease ${leaseUuid} poll timed out after ${timeoutMs}ms (last state: ${lastState !== undefined ? leaseStateName(lastState) : 'unknown'}, provision_status: ${lastProvisionStatus ?? 'unknown'})`,
  );
}
