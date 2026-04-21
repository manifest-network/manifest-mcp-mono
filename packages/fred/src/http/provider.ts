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

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function checkedFetch(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const callerSignal = init?.signal ?? undefined;

  // Compose the caller's signal with an internal timeout so callers cannot
  // accidentally disable the safety net by supplying their own signal.
  const composed = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let callerAbortHandler: (() => void) | undefined;

  if (callerSignal?.aborted) {
    composed.abort(callerSignal.reason);
  } else if (callerSignal) {
    callerAbortHandler = () => composed.abort(callerSignal.reason);
    callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
  }
  if (timeoutMs > 0 && !composed.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      composed.abort();
    }, timeoutMs);
  }

  let res: Response;
  try {
    // Don't even dispatch fetch if the caller's signal is already aborted.
    composed.signal.throwIfAborted();
    res = await fetchFn(url, { ...init, signal: composed.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (timedOut) {
        throw new ProviderApiError(
          0,
          `Request to ${url} timed out after ${timeoutMs}ms`,
        );
      }
      // Surface the caller's original abort reason (e.g. `new Error('cancelled')`)
      // rather than the fetch-internal DOMException AbortError.
      throw composed.signal.reason;
    }
    if (composed.signal.aborted && !timedOut) throw composed.signal.reason;
    throw new ProviderApiError(
      0,
      `Network request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (callerAbortHandler && callerSignal) {
      callerSignal.removeEventListener('abort', callerAbortHandler);
    }
  }
  if (!res.ok) {
    const body = await res
      .text()
      .catch(
        (readErr: unknown) =>
          `[body read failed: ${readErr instanceof Error ? readErr.message : String(readErr)}]`,
      );
    throw new ProviderApiError(res.status, body || `HTTP ${res.status}`);
  }
  return res;
}

export async function parseJsonResponse<T>(
  res: Response,
  url: string,
): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (parseErr) {
    const reason =
      parseErr instanceof Error ? parseErr.message : 'parse failed';
    throw new ProviderApiError(
      res.status,
      `Invalid JSON from ${url} (${reason}): ${text.slice(0, 200)}`,
    );
  }
}

export interface ProviderHealthResponse {
  readonly status: string;
  readonly provider_uuid: string;
  readonly checks?: {
    readonly chain?: { readonly status: string };
  };
}

export async function getProviderHealth(
  providerApiUrl: string,
  timeoutMs = 5_000,
  fetchFn?: typeof globalThis.fetch,
): Promise<ProviderHealthResponse> {
  const validated = validateProviderUrl(providerApiUrl);
  const url = `${validated}/health`;
  const res = await checkedFetch(url, undefined, timeoutMs, fetchFn);
  return await parseJsonResponse<ProviderHealthResponse>(res, url);
}

export interface InstanceInfo {
  readonly instance_index: number;
  readonly container_id: string;
  readonly image: string;
  readonly status: string;
  readonly ports?: Record<string, unknown>;
  readonly fqdn?: string;
}

export interface ServiceConnectionDetails {
  readonly host?: string;
  readonly fqdn?: string;
  readonly ports?: Record<string, unknown>;
  readonly instances?: readonly InstanceInfo[];
}

export interface ConnectionDetails {
  readonly host: string;
  readonly fqdn?: string;
  readonly ports?: Record<string, unknown>;
  readonly instances?: readonly InstanceInfo[];
  readonly protocol?: string;
  readonly metadata?: Record<string, string>;
  readonly services?: Record<string, ServiceConnectionDetails>;
}

export interface LeaseConnectionResponse {
  readonly lease_uuid: string;
  readonly tenant: string;
  readonly provider_uuid: string;
  readonly connection: ConnectionDetails;
}

export async function getLeaseConnectionInfo(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<LeaseConnectionResponse> {
  const validated = validateProviderUrl(providerApiUrl);
  const url = `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/connection`;
  const res = await checkedFetch(
    url,
    {
      headers: { Authorization: `Bearer ${authToken}` },
    },
    undefined,
    fetchFn,
  );
  return await parseJsonResponse<LeaseConnectionResponse>(res, url);
}

export async function uploadLeaseData(
  providerApiUrl: string,
  leaseUuid: string,
  payload: Uint8Array,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
  abortSignal?: AbortSignal,
): Promise<void> {
  const validated = validateProviderUrl(providerApiUrl);
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/octet-stream',
    },
    body: payload,
  };
  if (abortSignal) {
    init.signal = abortSignal;
  }
  await checkedFetch(
    `${validated}/v1/leases/${encodeURIComponent(leaseUuid)}/data`,
    init,
    undefined,
    fetchFn,
  );
}
