import { ProviderApiError, checkedFetch, parseJsonResponse, validateProviderUrl } from './provider.js';

const MAX_TAIL = 1000;

export interface FredLeaseStatus {
  readonly status: string;
  readonly services?: Record<string, { readonly ready: boolean; readonly available: number; readonly total: number }>;
}

export async function getLeaseStatus(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredLeaseStatus> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/status`;
  const res = await checkedFetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  }, undefined, fetchFn);
  return await parseJsonResponse<FredLeaseStatus>(res, url);
}

export interface FredLeaseLogs {
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
  const res = await checkedFetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  }, undefined, fetchFn);
  return await parseJsonResponse<FredLeaseLogs>(res, url);
}

export interface FredLeaseProvision {
  readonly status: string;
  readonly fail_count?: number;
  readonly last_error?: string;
}

export async function getLeaseProvision(
  providerUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredLeaseProvision> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/provision`;
  const res = await checkedFetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  }, undefined, fetchFn);
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
  const res = await checkedFetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
  }, undefined, fetchFn);
  return await parseJsonResponse<FredActionResponse>(res, url);
}

export async function updateLease(
  providerUrl: string,
  leaseUuid: string,
  payload: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<FredActionResponse> {
  const validated = validateProviderUrl(providerUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/update`;
  const res = await checkedFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/octet-stream',
    },
    body: payload,
  }, undefined, fetchFn);
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
  const res = await checkedFetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  }, undefined, fetchFn);
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
  const res = await checkedFetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  }, undefined, fetchFn);
  return await parseJsonResponse<FredLeaseInfo>(res, url);
}

export interface PollOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export async function pollLeaseUntilReady(
  providerUrl: string,
  leaseUuid: string,
  authToken: string | (() => Promise<string>),
  opts: PollOptions = {},
  fetchFn?: typeof globalThis.fetch,
): Promise<FredLeaseStatus> {
  const { intervalMs = 3_000, timeoutMs = 120_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastStatus: string | undefined;

  while (Date.now() < deadline) {
    const token = typeof authToken === 'function' ? await authToken() : authToken;
    const status = await getLeaseStatus(providerUrl, leaseUuid, token, fetchFn);
    lastStatus = status.status;
    if (status.status === 'ready' || status.status === 'running') {
      return status;
    }
    if (status.status === 'failed' || status.status === 'error') {
      throw new ProviderApiError(0, `Lease ${leaseUuid} entered ${status.status} state`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new ProviderApiError(0, `Lease ${leaseUuid} poll timed out after ${timeoutMs}ms (last status: ${lastStatus ?? 'unknown'})`);
}
