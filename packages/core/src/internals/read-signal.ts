import type { ReadCtx } from '../ctx.js';
import {
  abortReason,
  type CallOptions,
  resolveCallSignal,
} from '../options.js';

/**
 * Race a manifestjs read against the caller's effective AbortSignal (composed from `opts.signal` +
 * `opts.timeout` via `resolveCallSignal`). Pre-checks `sig.aborted` BEFORE `acquireRateLimit` so an
 * already-aborted call consumes neither a rate-limit token nor a connection, and RE-checks after the
 * token wait. NOTE: manifestjs query methods accept NO AbortSignal — the underlying RPC is NOT truly
 * cancelled (fire-and-forget); we only stop AWAITING it. A timeout rejects with the TimeoutError
 * DOMException from AbortSignal.timeout; a caller abort propagates the caller's reason (AbortError by
 * default) — so callers distinguish "timed out" from "cancelled".
 *
 * CONVENTION — a cancelled READ rejects with the caller's own abort reason, VERBATIM and unwrapped
 * (the WHATWG DOM rule for an API that accepts an `AbortSignal`); only a reason carrying nothing at
 * all is replaced, by {@link abortReason}. The tx seam does the opposite on purpose — see
 * `tx-confirmation.ts`. Consequence: the thrown value NEED NOT BE AN `Error`, and over MCP it usually
 * is not — the cancellation notification's `reason` is `z.string().optional()`, so a client-side
 * request timeout arrives as the bare string `McpError: MCP error -32001: Request timed out`.
 * **Detect a cancellation from `signal.aborted`, never from the error's shape or its message.**
 *
 * All three abort sites route through {@link abortReason} rather than the built-in
 * `signal.throwIfAborted()`, deliberately: the built-in rethrows `reason` RAW, so `abort(null)` would
 * throw `null` at the pre-checks — rendered by `withErrorHandling` as the literal message "null",
 * the same defect ENG-703 fixed for "undefined" — while an abort arriving one line later, through
 * the listener, would be normalized. One rule per file beats the standard spelling here (ENG-710).
 */
export async function withReadSignal<T>(
  ctx: Pick<ReadCtx, 'chain'>,
  read: () => Promise<T>,
  opts?: CallOptions,
): Promise<T> {
  const signal = resolveCallSignal(opts); // compute ONCE (a 2nd call would mint a 2nd timeout)
  if (signal === undefined) {
    await ctx.chain.acquireRateLimit();
    return read();
  }
  if (signal.aborted) throw abortReason(signal);
  // Cancellable since ENG-710: an abort landing mid-contention rejects at once and spends no
  // token. It used to surface only once the token arrived — measured at 3004ms on a 3s limiter.
  await ctx.chain.acquireRateLimit(signal);
  // NOT redundant now that the wait above is signal-aware. Two live windows: (1) `ctx` is taken
  // STRUCTURALLY, so a hand-built ctx, a test double, or — under the caret peerDependency range —
  // an older core whose acquireRateLimit ignores its argument, is gated by nothing else; (2) the
  // microtask gap between that await resolving and this line, where another queued microtask can
  // abort. Window 2's token is already spent and unrecoverable; what ENG-710 removed is the
  // multi-second window, not the infinitesimal one.
  if (signal.aborted) throw abortReason(signal);
  const readPromise = read();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    // No `readPromise.catch(() => {})` swallow: `.then(resolve, reject)` is attached
    // synchronously in this same tick, so a rejection arriving after the abort already won is
    // handled and never reaches `unhandledRejection` (verified, ENG-710). Contrast
    // agent-core's `raceAbort` already-aborted early return, which attaches no handler at all
    // and therefore keeps its swallow.
    readPromise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}
