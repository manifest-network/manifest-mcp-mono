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
  const url = `${validated}/fred/lease/${leaseUuid}/status`;
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
  const url = `${validated}/fred/lease/${leaseUuid}/logs${qs}`;
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
  const url = `${validated}/fred/lease/${leaseUuid}/provision`;
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
  const url = `${validated}/fred/lease/${leaseUuid}/restart`;
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
  const url = `${validated}/fred/lease/${leaseUuid}/update`;
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

  while (Date.now() < deadline) {
    const token = typeof authToken === 'function' ? await authToken() : authToken;
    const status = await getLeaseStatus(providerUrl, leaseUuid, token, fetchFn);
    if (status.status === 'ready' || status.status === 'running') {
      return status;
    }
    if (status.status === 'failed' || status.status === 'error') {
      throw new ProviderApiError(0, `Lease ${leaseUuid} entered ${status.status} state`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new ProviderApiError(0, `Lease ${leaseUuid} poll timed out after ${timeoutMs}ms`);
}
