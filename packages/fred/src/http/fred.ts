import { toBase64 } from '@cosmjs/encoding';
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

export const MAX_TAIL = 1000;

export interface FredInstanceInfo {
  readonly name: string;
  readonly status: string;
  readonly ports?: Record<string, number>;
  readonly fqdn?: string;
}

export interface FredServiceStatus {
  readonly instances: readonly FredInstanceInfo[];
}

export interface FredLeaseStatus {
  readonly state: LeaseState;
  readonly provision_status?: string;
  readonly phase?: string;
  readonly steps?: Record<string, string>;
  readonly instances?: readonly FredInstanceInfo[];
  readonly endpoints?: Record<string, string>;
  readonly last_error?: string;
  readonly fail_count?: number;
  readonly created_at?: string;
  readonly services?: Record<string, FredServiceStatus>;
}

/** Raw wire shape before LeaseState conversion */
interface RawLeaseStatus extends Omit<FredLeaseStatus, 'state'> {
  readonly state: string;
}

export async function getLeaseStatus(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredLeaseStatus> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/status`;
  const res = await checkedFetch(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
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

export interface FredLeaseLogs {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly logs: Record<string, string>;
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

export interface FredLeaseProvision {
  readonly status: string;
  readonly fail_count: number;
  readonly last_error: string;
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

export interface FredActionResponse {
  readonly status: string;
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

export interface FredLeaseRelease {
  readonly version: number;
  readonly image: string;
  readonly status: string;
  readonly created_at: string;
  readonly error?: string;
  readonly manifest?: string;
}

export interface FredLeaseReleases {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly releases: readonly FredLeaseRelease[];
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

export interface FredLeaseInfo {
  readonly host: string;
  readonly ports?: Record<string, unknown>;
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

export interface PollOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (status: FredLeaseStatus) => void;
}

function leaseStateName(state: LeaseState): string {
  return LeaseState[state] ?? String(state);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
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
  } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastState: LeaseState | undefined;

  while (Date.now() < deadline) {
    abortSignal?.throwIfAborted();
    const token =
      typeof authToken === 'function' ? await authToken() : authToken;
    const status = await getLeaseStatus(providerUrl, leaseUuid, token, fetchFn);
    lastState = status.state;
    onProgress?.(status);
    switch (status.state) {
      case LeaseState.LEASE_STATE_ACTIVE:
        return status;
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
    `Lease ${leaseUuid} poll timed out after ${timeoutMs}ms (last state: ${lastState !== undefined ? leaseStateName(lastState) : 'unknown'})`,
  );
}
