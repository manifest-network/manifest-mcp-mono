import {
  isBlocked,
  isIpLiteral,
} from '@manifest-network/manifest-mcp-core/ssrf';
import { hasInjectedFetch, warnUnguardedOnce } from './unguarded-warning.js';

/** Global-registry brand so `isProviderApiError` survives duplicate physical copies of this
 *  package (the dual-package hazard) — the React `$$typeof` idiom. Symbol.for resolves to the
 *  same symbol across copies; a bare `instanceof` does not. */
const PROVIDER_API_ERROR_BRAND = Symbol.for(
  '@manifest-network/manifest-mcp-fred.ProviderApiError',
);

/**
 * What kind of fault produced a `ProviderApiError`. Exists because `status` is
 * `0` for every non-HTTP failure — invalid URL, SSRF reject, connect error,
 * timeout, body-cap breach, malformed JSON, poll outcome — so `status` alone
 * cannot tell a retryable blip from a permanent rejection (ENG-661).
 *
 * OPTIONAL by design: an error constructed without one (a third-party or older
 * call site) is treated as unclassified, and `isTransientProviderError` falls
 * back to the HTTP status. Adding a tag must never make an untagged error
 * *more* retryable than it is today.
 */
export type ProviderErrorKind =
  | 'http'
  | 'network'
  | 'timeout'
  | 'invalid_url'
  | 'invalid_json'
  | 'body_cap'
  /** The readiness poll gave up without an answer (deadline / provider unreachable). */
  | 'poll'
  /**
   * The provider ANSWERED, and the answer was failure — `PROVISION_FAILED`, a
   * terminal lease state, or a state this client cannot interpret. The
   * distinction from `poll` is what lets a caller tell "the deployment failed"
   * from "we never found out", which decides whether destructive cleanup advice
   * is honest (ENG-661).
   */
  | 'poll_verdict';

export interface ProviderApiErrorOptions {
  readonly kind?: ProviderErrorKind;
  /** Parsed `Retry-After` in ms, when the provider sent one (see `parseRetryAfterMs`). */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class ProviderApiError extends Error {
  public readonly status: number;
  public readonly kind?: ProviderErrorKind;
  public readonly retryAfterMs?: number;
  /**
   * The underlying error, when this one wraps another. Declared here rather
   * than passed to `super(message, { cause })` because the repo compiles
   * against `lib: ES2020`, where `ErrorOptions` does not exist yet.
   */
  public readonly cause?: unknown;

  constructor(status: number, message: string, opts?: ProviderApiErrorOptions) {
    super(message);
    this.name = 'ProviderApiError';
    this.status = status;
    this.kind = opts?.kind;
    this.retryAfterMs = opts?.retryAfterMs;
    this.cause = opts?.cause;
    Object.setPrototypeOf(this, ProviderApiError.prototype);
    // Dual-package-safe brand. Defined NON-enumerably (default descriptor) so it never appears
    // in JSON.stringify / Object.entries / spread / sanitizeForLogging. Inherited by subclasses
    // (TerminalChainStateError, LeaseReadinessUnconfirmedError) via this super() call.
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

/** Upper bound on a parsed `Retry-After`, matching Fred's own cap on the value it
 *  emits (`maxRetryAfterSeconds = 86400`, internal/api/ratelimit.go). A hostile or
 *  buggy intermediary can send anything; callers additionally clamp to their own
 *  deadline before sleeping. */
const MAX_RETRY_AFTER_MS = 86_400_000;

/**
 * Parse an RFC 9110 `Retry-After` header value into milliseconds.
 *
 * Both wire forms are accepted: delta-seconds (`"1"` — what Fred emits, see
 * `calcRetryAfterSeconds` in internal/api/ratelimit.go) and an HTTP-date, which
 * an intermediary proxy may substitute. A date already in the past yields `0`
 * ("retry now"), not a negative sleep. Anything unparseable — including a
 * negative delta — yields `undefined`, meaning "no guidance", so the caller
 * keeps its own interval rather than trusting garbage.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return undefined;
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  // Every RFC 9110 HTTP-date form carries a weekday/month NAME and spaces
  // ("Sun, 06 Nov 1994 08:49:37 GMT"). Requiring both before handing the value
  // to Date.parse keeps its very loose grammar from turning junk into a date —
  // V8 reads a bare "-5" as a year and yields a valid timestamp.
  if (!/[A-Za-z]/.test(trimmed) || !trimmed.includes(' ')) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
}

/**
 * Is this provider-HTTP failure worth another attempt?
 *
 * The single source of truth for "tolerable" on the provider path — the
 * readiness poll's consecutive-failure budget consumes it (ENG-661/ENG-479).
 * Deliberately NOT core's `isRetryableError`: that classifier reaches a
 * `ProviderApiError` only through its generic `Error` branch, where the message
 * is a raw provider response body, so a Fred 5xx (`{"error":"…","code":500}`)
 * fails its `/\b(?:http|status)\s*5\d{2}\b/` sniff while a 429 matches only by
 * the accident of Fred echoing the status into the JSON body.
 *
 * Two rows are non-obvious. `invalid_json` IS transient: a truncated body or an
 * intermediary's HTML error page is a classic blip. `body_cap` is NOT: a
 * provider streaming past the 10 MiB ceiling will do it again, and re-reading
 * burns bandwidth. Anything that is not a `ProviderApiError` (a `TypeError`
 * from a bug, say) is never tolerated — swallowing it for N iterations and then
 * blaming the provider is a debugging trap.
 */
export function isTransientProviderError(err: unknown): boolean {
  if (!ProviderApiError.isProviderApiError(err)) return false;
  switch (err.kind) {
    case 'network':
    case 'timeout':
    case 'invalid_json':
      return true;
    case 'invalid_url':
    case 'body_cap':
    case 'poll':
    case 'poll_verdict':
      return false;
    default:
      // 'http', and errors from a call site that predates `kind`: fall back to
      // the status. 5xx = the provider is unwell; 429 = it asked us to wait.
      // Every other 4xx is a stable answer that will not change on retry.
      return err.status >= 500 || err.status === 429;
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
    throw new ProviderApiError(0, `Invalid provider URL: ${url}`, {
      kind: 'invalid_url',
    });
  }

  if (!isUrlSsrfSafe(url, opts)) {
    throw new ProviderApiError(
      0,
      `Provider URL is not allowed: its host is localhost or a non-public IP literal (loopback, private, link-local/metadata, CGNAT, or reserved): ${url}`,
      { kind: 'invalid_url' },
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
    { kind: 'invalid_url' },
  );
}

/**
 * Default budget for a whole provider HTTP call — headers AND body. Exported so a
 * direct `readBodyCapped` / `parseJsonResponse` caller can see (and match) the bound
 * their body read is subject to.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * A composed caller-signal + internal-timeout, armed for the life of one call.
 *
 * Deliberately hand-rolled rather than `AbortSignal.any([signal, AbortSignal.timeout(ms)])`:
 * this needs to *disarm* the timeout the moment the caller aborts first, so a delayed
 * fetch rejection is not misclassified as a timeout. `AbortSignal.any` offers no way to
 * cancel one leg, and `timedOut()` would degrade to sniffing `reason.name`, which a
 * caller's own reason could collide with.
 */
interface ArmedDeadline {
  readonly signal: AbortSignal;
  /** True iff the INTERNAL timeout fired — as opposed to the caller cancelling. */
  timedOut(): boolean;
  /** Idempotent: clears the timer and detaches the caller-signal listener. */
  dispose(): void;
}

function armDeadline(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): ArmedDeadline {
  const composed = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let callerAbortHandler: (() => void) | undefined;

  if (callerSignal?.aborted) {
    composed.abort(callerSignal.reason);
  } else if (callerSignal) {
    callerAbortHandler = () => {
      // Clear the timer so a delayed rejection can't be misclassified as a
      // timeout after the caller already cancelled.
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

  return {
    signal: composed.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (callerAbortHandler && callerSignal) {
        callerSignal.removeEventListener('abort', callerAbortHandler);
        callerAbortHandler = undefined;
      }
    },
  };
}

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

/** Deadline/cancellation control for a body read. */
export interface BodyReadOptions {
  /**
   * An externally-owned deadline (normally `checkedFetch`'s). When present NO local
   * timer is armed and the signal's reason is surfaced verbatim — the owner classifies.
   */
  readonly signal?: AbortSignal;
  /** Local deadline when `signal` is absent. `<= 0` disables it. */
  readonly timeoutMs?: number;
}

/**
 * Read a response body to a string under BOTH a byte ceiling and a deadline.
 *
 * Streams `res.body` and counts bytes, cancelling the stream and throwing a
 * `ProviderApiError` the moment the running total exceeds `maxBytes` — so an
 * oversized body never fully materializes in memory. A declared `Content-Length`
 * over the cap is rejected up front.
 *
 * The byte cap bounds MEMORY; it does not bound TIME. A provider that dripped one
 * byte per minute stayed forever under 10 MiB and read forever, which is why this
 * arms its own deadline whenever the caller does not supply one (ENG-662). The two
 * guards cover the two shapes: the cap kills a fast infinite stream, the deadline
 * kills a slow one.
 */
export async function readBodyCapped(
  res: Response,
  url: string,
  maxBytes: number = MAX_RESPONSE_BYTES,
  opts?: BodyReadOptions,
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  // Own a deadline only when nobody else does.
  const local = opts?.signal ? undefined : armDeadline(timeoutMs);
  const signal = opts?.signal ?? local?.signal;

  // Only a locally-owned timeout can be classified here; an external signal's
  // reason belongs to whoever armed it.
  const abortError = (): unknown =>
    local?.timedOut()
      ? new ProviderApiError(
          0,
          `Reading the response body from ${url} timed out after ${timeoutMs}ms (headers arrived; the body stalled)`,
          { kind: 'timeout' },
        )
      : (signal?.reason ??
        new DOMException('The operation was aborted', 'AbortError'));

  try {
    if (signal?.aborted) throw abortError();

    // Optional chaining: a real `Response` always has `.headers`, but keep the
    // fast-path tolerant of minimal test/mock objects — the streaming cap below
    // is the authoritative guard, this header check is just an early reject.
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Tear the body down before bailing so undici can release the socket back
      // to the pool immediately, rather than holding it until GC finalization.
      // Mirrors the `reader.cancel()` on the streamed-overflow path below.
      await res.body?.cancel().catch(() => {});
      throw new ProviderApiError(
        0,
        `Response from ${url} declares Content-Length ${declared} which exceeds the ${maxBytes}-byte cap; refusing to read.`,
        { kind: 'body_cap' },
      );
    }

    const reader = res.body?.getReader();
    if (!reader) {
      // No readable stream (empty body or a non-stream mock). There is no reader to
      // cancel, so bound it by RACING instead. A genuinely stuck `res.text()` is
      // abandoned rather than torn down — acceptable only because this branch is
      // unreachable for a real streamed response (one always exposes a reader, and a
      // null body has nothing to trickle).
      return await raceAbort(res.text(), signal, abortError, res);
    }

    // ONE listener for the whole read. Registering per-iteration would leak tens of
    // thousands of listeners on a large body.
    let onAbort: (() => void) | undefined;
    let abortPromise: Promise<never> | undefined;
    if (signal) {
      abortPromise = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      // Never let a post-loop abort surface as an unhandled rejection.
      abortPromise.catch(() => {});
    }

    const decoder = new TextDecoder();
    let text = '';
    let total = 0;
    try {
      while (true) {
        const { done, value } = abortPromise
          ? await Promise.race([reader.read(), abortPromise])
          : await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            // Swallow a rejecting cancel() so the meaningful cap error is the one
            // surfaced, not a teardown error — matches the Content-Length path.
            await reader.cancel().catch(() => {});
            throw new ProviderApiError(
              0,
              `Response body from ${url} exceeded the ${maxBytes}-byte cap; aborting to avoid memory exhaustion.`,
              { kind: 'body_cap' },
            );
          }
          text += decoder.decode(value, { stream: true });
        }
      }
      text += decoder.decode(); // flush any trailing multi-byte sequence
    } catch (err) {
      // On a real undici body an abort races two producers — our `abortPromise` and
      // `reader.read()` erroring — and `Promise.race` takes whichever settles first.
      // Classify off the signal so the surfaced error is deterministic.
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw abortError();
      }
      throw err;
    } finally {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
    return text;
  } finally {
    local?.dispose();
  }
}

/**
 * Settle `p`, or reject with `abortError()` if `signal` fires first. Single-executor
 * (rather than `Promise.race`) so the loser always has a handler attached and a late
 * rejection can never surface as unhandled.
 */
async function raceAbort<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined,
  abortError: () => unknown,
  res: Response,
): Promise<T> {
  if (!signal) return await p;
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => {
        // Best-effort socket release; harmless when the body is null.
        void res.body?.cancel().catch(() => {});
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject);
    });
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function checkedFetch(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  fetchFn?: typeof globalThis.fetch,
): Promise<Response> {
  // `fetchFn` is the SSRF connect-guard seam (layer 2). Omitting it falls back to unguarded
  // `globalThis.fetch` — fine in a browser, an SSRF surface on Node, since provider URLs come from
  // on-chain records. The MCP servers and `createFredClientNode` always inject a guarded fetch; the
  // raw HTTP functions on the fred barrel / SDK `/deploy` used to take this fallback SILENTLY, so
  // warn once here. Declared optional (rather than defaulted) precisely so "omitted" stays
  // distinguishable from "explicitly passed `globalThis.fetch`" — the latter is a deliberate opt-out
  // and must not warn. Externally the signature is unchanged (`fetchFn?`), so callers are unaffected.
  warnUnguardedOnce(hasInjectedFetch(fetchFn));
  const doFetch = fetchFn ?? globalThis.fetch;

  const deadline = armDeadline(timeoutMs, init?.signal ?? undefined);
  try {
    return await checkedFetchWithin(url, init, deadline, timeoutMs, doFetch);
  } finally {
    // The SUCCESS path deliberately disarms here: `checkedFetch` returns before the
    // body is read, so it has nothing coherent to hand forward. Reading that body
    // through `readBodyCapped` / `parseJsonResponse` re-arms a fresh deadline;
    // calling `res.text()` on it directly is bounded by NEITHER cap, which is why
    // `fetchJsonChecked` — one budget across both phases — is the entry point every
    // provider read in this repo uses.
    deadline.dispose();
  }
}

/**
 * The fetch + non-2xx handling of `checkedFetch`, inside an already-armed deadline so
 * `fetchJsonChecked` can extend the same budget over its body read.
 *
 * The nested try is load-bearing: the `!res.ok` branch throws a `ProviderApiError`, and
 * letting that fall into the transport `catch` would re-wrap every non-2xx as
 * `kind: 'network'`.
 */
async function checkedFetchWithin(
  url: string,
  init: RequestInit | undefined,
  deadline: ArmedDeadline,
  timeoutMs: number,
  doFetch: typeof globalThis.fetch,
): Promise<Response> {
  let res: Response;
  try {
    // Don't even dispatch fetch if the caller's signal is already aborted.
    deadline.signal.throwIfAborted();
    res = await doFetch(url, { ...init, signal: deadline.signal });
  } catch (err) {
    throw classifyTransportError(err, deadline, url, timeoutMs);
  }
  if (!res.ok) {
    // Read `Retry-After` BEFORE the body: it is the provider's own guidance on
    // when a retry is welcome, and discarding it (as this did) meant the poll
    // could only guess (ENG-661). Valid on 503 as well as 429, so it is read for
    // any non-2xx. Optional chaining mirrors `readBodyCapped`'s defensive header
    // read so minimal test/mock Response objects keep working.
    const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
    // A body that breaches the 10 MiB cap must keep its `body_cap` kind even
    // though the status makes this look like a plain `http` failure. Reading the
    // error into text and re-tagging it `http` would launder a NON-transient
    // fault into a transient one for any 5xx, so the readiness poll would retry
    // and re-stream up to 10 MiB per attempt — exactly what the cap exists to
    // prevent. The real HTTP status is preserved either way.
    let capBreached = false;
    let bodyTimedOut = false;
    // This read is now INSIDE the armed window. It used to sit after the teardown,
    // so a provider that returned error headers promptly and then trickled the body
    // hung here forever, immune to both the timeout and the caller's cancel (ENG-662).
    const body = await readBodyCapped(res, url, MAX_RESPONSE_BYTES, {
      signal: deadline.signal,
    }).catch((readErr: unknown) => {
      // A caller cancel is the whole call being cancelled, not a body fault — it must
      // never be laundered into placeholder text. `pollLeaseUntilReady` keys
      // cancellation off the signal, so the error's identity matters here.
      if (deadline.signal.aborted && !deadline.timedOut()) {
        throw deadline.signal.reason;
      }
      bodyTimedOut = deadline.timedOut();
      capBreached =
        ProviderApiError.isProviderApiError(readErr) &&
        readErr.kind === 'body_cap';
      return bodyTimedOut
        ? `[body read from ${url} timed out after ${timeoutMs}ms]`
        : `[body read failed: ${readErr instanceof Error ? readErr.message : String(readErr)}]`;
    });
    throw new ProviderApiError(res.status, body || `HTTP ${res.status}`, {
      kind: capBreached ? 'body_cap' : bodyTimedOut ? 'timeout' : 'http',
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    });
  }
  return res;
}

function classifyTransportError(
  err: unknown,
  deadline: ArmedDeadline,
  url: string,
  timeoutMs: number,
): unknown {
  if (err instanceof DOMException && err.name === 'AbortError') {
    if (deadline.timedOut()) {
      return new ProviderApiError(
        0,
        `Request to ${url} timed out after ${timeoutMs}ms`,
        { kind: 'timeout' },
      );
    }
    // Surface the caller's original abort reason (e.g. `new Error('cancelled')`)
    // rather than the fetch-internal DOMException AbortError.
    return deadline.signal.reason;
  }
  if (deadline.signal.aborted && !deadline.timedOut()) {
    return deadline.signal.reason;
  }
  return new ProviderApiError(
    0,
    `Network request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    { kind: 'network', cause: err },
  );
}

/**
 * `checkedFetch` + `parseJsonResponse` under ONE deadline, so `timeoutMs` is a budget
 * for the whole call rather than for each phase separately. This is the right entry
 * point for every provider read; raw `checkedFetch` hands back a `Response` whose body
 * the caller must bound itself.
 */
export async function fetchJsonChecked<T>(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
  fetchFn?: typeof globalThis.fetch,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<T> {
  warnUnguardedOnce(hasInjectedFetch(fetchFn));
  const doFetch = fetchFn ?? globalThis.fetch;
  const deadline = armDeadline(timeoutMs, init?.signal ?? undefined);
  try {
    const res = await checkedFetchWithin(
      url,
      init,
      deadline,
      timeoutMs,
      doFetch,
    );
    const text = await readBodyCapped(res, url, maxBytes, {
      signal: deadline.signal,
    }).catch((err: unknown) => {
      throw classifyBodyError(err, deadline, url, timeoutMs);
    });
    // `res.status`, NOT 0: restoreApp distinguishes "restore COMMITTED but the 202
    // body was empty" from a real failure by branching on a 2xx status here.
    return parseJsonText<T>(text, res.status, url);
  } finally {
    deadline.dispose();
  }
}

function classifyBodyError(
  err: unknown,
  deadline: ArmedDeadline,
  url: string,
  timeoutMs: number,
): unknown {
  if (deadline.timedOut()) {
    return new ProviderApiError(
      0,
      `Reading the response body from ${url} timed out after ${timeoutMs}ms (headers arrived; the body stalled)`,
      { kind: 'timeout' },
    );
  }
  return err;
}

function parseJsonText<T>(text: string, status: number, url: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (parseErr) {
    const reason =
      parseErr instanceof Error ? parseErr.message : 'parse failed';
    throw new ProviderApiError(
      status,
      `Invalid JSON from ${url} (${reason}): ${text.slice(0, 200)}`,
      { kind: 'invalid_json', cause: parseErr },
    );
  }
}

export async function parseJsonResponse<T>(
  res: Response,
  url: string,
  maxBytes: number = MAX_RESPONSE_BYTES,
  opts?: BodyReadOptions,
): Promise<T> {
  const text = await readBodyCapped(res, url, maxBytes, opts);
  return parseJsonText<T>(text, res.status, url);
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
  return await fetchJsonChecked<ProviderHealthResponse>(
    url,
    undefined,
    timeoutMs,
    fetchFn,
  );
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
  return await fetchJsonChecked<LeaseConnectionResponse>(
    url,
    { headers: { Authorization: `Bearer ${authToken}` } },
    undefined,
    fetchFn,
  );
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
