export class ProviderApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderApiError';
    this.status = status;
    Object.setPrototypeOf(this, ProviderApiError.prototype);
  }
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function validateProviderUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderApiError(0, `Invalid provider URL: ${url}`);
  }

  if (parsed.protocol === 'https:') {
    return url.replace(/\/+$/, '');
  }

  if (parsed.protocol === 'http:' && LOCALHOST_HOSTS.has(parsed.hostname)) {
    return url.replace(/\/+$/, '');
  }

  throw new ProviderApiError(
    0,
    `Provider URL must use HTTPS (or HTTP for localhost): ${url}`,
  );
}

export async function checkedFetch(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new ProviderApiError(
      0,
      `Network request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  const validated = validateProviderUrl(providerApiUrl);
  const url = `${validated}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await checkedFetch(url, { signal: controller.signal });
    return await parseJsonResponse<ProviderHealthResponse>(res, url);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ProviderApiError(0, `Provider health check timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
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
  const validated = validateProviderUrl(providerApiUrl);
  const url = `${validated}/lease/${leaseUuid}/connection`;
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
  const validated = validateProviderUrl(providerApiUrl);
  await checkedFetch(`${validated}/lease/${leaseUuid}/data`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/octet-stream',
    },
    body: payload,
  });
}
