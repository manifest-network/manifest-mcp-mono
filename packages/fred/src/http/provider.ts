import {
  isBlocked,
  isIpLiteral,
} from '@manifest-network/manifest-mcp-core/ssrf';

/** Global-registry brand so `isProviderApiError` survives duplicate physical copies of this
 *  package (the dual-package hazard) — the React `$$typeof` idiom. Symbol.for resolves to the
 *  same symbol across copies; a bare `instanceof` does not. */
const PROVIDER_API_ERROR_BRAND = Symbol.for(
  '@manifest-network/manifest-mcp-fred.ProviderApiError',
);

export class ProviderApiError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderApiError';
    this.status = status;
    Object.setPrototypeOf(this, ProviderApiError.prototype);
    // Dual-package-safe brand. Defined NON-enumerably (default descriptor) so it never appears
    // in JSON.stringify / Object.entries / spread / sanitizeForLogging. Inherited by subclasses
    // (TerminalChainStateError) via this super() call.
    Object.defineProperty(this, PROVIDER_API_ERROR_BRAND, { value: true });
  }

  /** Dual-package-safe guard — robust where cross-copy `instanceof` fails. Also matches
   *  subclasses (e.g. TerminalChainStateError, which inherits the brand). */
  static isProviderApiError(value: unknown): value is ProviderApiError {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[PROVIDER_API_ERROR_BRAND] === true
    );
  }
}

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ProviderUrlOptions {
  /**
   * Re-allow loopback hosts (localhost / 127.0.0.1 / ::1) for local dev + e2e.
   * Default false. NARROW by design — never re-allows RFC1918 or the
   * 169.254.169.254 metadata endpoint.
   */
  readonly allowLoopback?: boolean;
}

/**
 * Pure, protocol-agnostic SSRF predicate for a provider URL (works for
 * https:// AND wss://). Classifies the WHATWG-parsed host: literal IPs +
 * `localhost` only.
 *
 * DEFENSE-IN-DEPTH, NOT a rebinding-proof guard: a DNS hostname cannot be
 * resolved here, so hostnames FAIL OPEN (return true). The authoritative
 * post-resolution check is the node connect-time guard (createGuardedFetch,
 * ENG-444); browsers additionally enforce Private Network Access / CORS.
 * Resolving DNS here would need node:dns (breaks browser-purity) and
 * reintroduce the resolve-then-validate TOCTOU that gets bypassed.
 * Obfuscated literal IPs (decimal/hex/octal/short-form, v4-mapped v6) ARE
 * caught — `new URL()` normalizes them first. Residual hostname tricks that
 * RESOLVE to internal IPs (trailing-dot `localhost.`, wildcard-DNS like
 * `*.nip.io`, DNS rebinding) are intentionally NOT handled here.
 */
export function isUrlSsrfSafe(
  url: string,
  opts: ProviderUrlOptions = {},
): boolean {
  const { allowLoopback = false } = opts;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false; // unparseable URL → unsafe
  }
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  if (bare === 'localhost') return allowLoopback; // DNS name treated as loopback
  if (!isIpLiteral(bare)) return true; // other DNS name → fail open (see doc)
  const blocked = isBlocked(bare); // safe: bare is an IP literal
  if (!blocked) return true; // unicast / public
  return blocked.range === 'loopback' && allowLoopback; // narrow re-allow
}

export function validateProviderUrl(
  url: string,
  opts: ProviderUrlOptions = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderApiError(0, `Invalid provider URL: ${url}`);
  }

  if (!isUrlSsrfSafe(url, opts)) {
    throw new ProviderApiError(
      0,
      `Provider URL is not allowed: its host is localhost or a non-public IP literal (loopback, private, link-local/metadata, CGNAT, or reserved): ${url}`,
    );
  }

  if (parsed.protocol === 'https:') {
    return url.replace(/\/+$/, '');
  }
  if (
    parsed.protocol === 'http:' &&
    LOCALHOST_HOSTS.has(parsed.hostname) &&
    opts.allowLoopback
  ) {
    return url.replace(/\/+$/, '');
  }
  throw new ProviderApiError(
    0,
    `Provider URL must use HTTPS (or HTTP for localhost with allowLoopback): ${url}`,
  );
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Hard ceiling on a provider HTTP response body (10 MiB). Provider payloads
 * are small — status/health/connection are a few KB, and logs are already
 * bounded upstream (`MAX_TAIL` requested lines, `MAX_LOG_CHARS` on display).
 * A body over 10 MiB indicates a hostile or buggy provider; abort rather than
 * risk OOM. This is a TRANSPORT-layer cap, distinct from the AI-context caps:
 * provider `apiUrl`s come from on-chain SKU records, so a malicious provider
 * could otherwise stream an unbounded body into the local server's heap.
 */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Read a response body to a string while enforcing a hard byte ceiling.
 *
 * Streams `res.body` and counts bytes, cancelling the stream and throwing a
 * `ProviderApiError` the moment the running total exceeds `maxBytes` — so an
 * oversized body never fully materializes in memory. A declared
 * `Content-Length` over the cap is rejected up front. Replaces the unbounded
 * `await res.text()` that every provider read previously funnelled through.
 */
export async function readBodyCapped(
  res: Response,
  url: string,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  // Optional chaining: a real `Response` always has `.headers`, but keep the
  // fast-path tolerant of minimal test/mock objects — the streaming cap below
  // is the authoritative guard, this header check is just an early reject.
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderApiError(
      0,
      `Response from ${url} declares Content-Length ${declared} which exceeds the ${maxBytes}-byte cap; refusing to read.`,
    );
  }

  const reader = res.body?.getReader();
  if (!reader) {
    // No readable stream (empty body or a non-stream mock). Nothing to buffer.
    return await res.text();
  }

  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new ProviderApiError(
            0,
            `Response body from ${url} exceeded the ${maxBytes}-byte cap; aborting to avoid memory exhaustion.`,
          );
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode(); // flush any trailing multi-byte sequence
  } finally {
    reader.releaseLock();
  }
  return text;
}

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
    callerAbortHandler = () => {
      // Clear the timer so a delayed fetch rejection can't be misclassified
      // as a timeout after the caller already cancelled.
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      composed.abort(callerSignal.reason);
    };
    callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
  }
  if (timeoutMs > 0 && !composed.signal.aborted) {
    timer = setTimeout(() => {
      // Defensive: if the caller already aborted, don't flip timedOut.
      if (composed.signal.aborted) return;
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
    const body = await readBodyCapped(res, url).catch(
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
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<T> {
  const text = await readBodyCapped(res, url, maxBytes);
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
  allowLoopback = false,
): Promise<ProviderHealthResponse> {
  const validated = validateProviderUrl(providerApiUrl, { allowLoopback });
  const url = `${validated}/health`;
  const res = await checkedFetch(url, undefined, timeoutMs, fetchFn);
  return await parseJsonResponse<ProviderHealthResponse>(res, url);
}

import type {
  ConnectionDetails,
  InstanceInfo,
  LeaseConnectionResponse,
  ServiceConnectionDetails,
} from '@manifest-network/manifest-mcp-core';

export type {
  ConnectionDetails,
  InstanceInfo,
  LeaseConnectionResponse,
  ServiceConnectionDetails,
};

export async function getLeaseConnectionInfo(
  providerApiUrl: string,
  leaseUuid: string,
  authToken: string,
  fetchFn?: typeof globalThis.fetch,
  allowLoopback = false,
): Promise<LeaseConnectionResponse> {
  const validated = validateProviderUrl(providerApiUrl, { allowLoopback });
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
  allowLoopback = false,
): Promise<void> {
  const validated = validateProviderUrl(providerApiUrl, { allowLoopback });
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
