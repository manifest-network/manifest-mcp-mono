export class ProviderApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderApiError';
    this.status = status;
    Object.setPrototypeOf(this, ProviderApiError.prototype);
  }
}

export async function checkedFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderApiError(res.status, body || `HTTP ${res.status}`);
  }
  return res;
}

export async function parseJsonResponse<T>(res: Response, url: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (parseErr) {
    const reason = parseErr instanceof Error ? parseErr.message : 'parse failed';
    throw new ProviderApiError(
      res.status,
      `Invalid JSON from ${url} (${reason}): ${text.slice(0, 200)}`,
    );
  }
}

export interface ProviderHealthResponse {
  readonly status: string;
  readonly provider_uuid: string;
}

export async function getProviderHealth(
  providerApiUrl: string,
  timeoutMs = 5_000,
): Promise<ProviderHealthResponse> {
  const url = `${providerApiUrl}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await checkedFetch(url, { signal: controller.signal });
    return await parseJsonResponse<ProviderHealthResponse>(res, url);
  } finally {
    clearTimeout(timer);
  }
}

export interface LeaseConnectionInfo {
  readonly host: string;
  readonly ports: Record<string, number>;
  readonly metadata?: Record<string, unknown>;
}

export async function getLeaseConnectionInfo(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
): Promise<LeaseConnectionInfo> {
  const url = `${providerApiUrl}/lease/${leaseUuid}/connection`;
  const res = await checkedFetch(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  return await parseJsonResponse<LeaseConnectionInfo>(res, url);
}

export async function uploadLeaseData(
  providerApiUrl: string,
  leaseUuid: string,
  payload: string,
  authToken: string,
): Promise<void> {
  await checkedFetch(`${providerApiUrl}/lease/${leaseUuid}/data`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/octet-stream',
    },
    body: payload,
  });
}
