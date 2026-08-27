import type { StdFee } from '@cosmjs/stargate'; // type-only: erased at build, no runtime dep
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/** Per-call options for typed READ building blocks. */
export interface CallOptions {
  /** Caller cancellation. Composed with `timeout` via AbortSignal.any. */
  signal?: AbortSignal;
  /**
   * Per-call deadline in ms. Surfaces as a TimeoutError (distinct from the caller's AbortError).
   * Must be an integer in `[1, MAX_TIMEOUT_MS]`; anything else throws `INVALID_CONFIG` at
   * `resolveCallSignal` rather than escaping as a raw Node `RangeError`/`TypeError`.
   *
   * DEADLINE FOR THE WHOLE OPERATION, not per attempt. The effective signal is resolved ONCE
   * per call, so a retry ladder underneath inherits the already-elapsed budget — attempt 3 gets
   * whatever is left, not a fresh `timeout`. That is the intended semantics; size the value for
   * the worst-case ladder, not for one attempt.
   *
   * COST OF COMPOSING ONE. When `signal` is also present the two are merged with
   * `AbortSignal.any`, and the DOM spec requires a composite to keep its source signals alive:
   * the timeout signal plus its armed timer are pinned in a process-global strong set for the
   * FULL `timeout` duration, whatever happens to the call. Measured: 0/300 timeout signals
   * collected once composed, vs 299/300 when not. A short-lived call with a long `timeout` is
   * therefore not free — prefer aborting the caller's own controller when you want it reclaimed
   * promptly.
   */
  timeout?: number;
}

/**
 * Per-call options for typed TRANSACTION building blocks. Fee precedence: an explicit
 * `fee` WINS (skips simulation / `gasMultiplier` / configured gasPrice — and is the one
 * path valid WITHOUT a configured gasPrice), but its `gas` must be a positive base-10
 * safe-integer string and remains subject to `config.maxGas` (default 50_000_000;
 * `-1` disables). This is a gas-unit ceiling, not a denom-aware spend limit: the caller
 * remains responsible for an explicit `fee.amount`. `gasMultiplier` applies only on the
 * simulate path. Passing both is a caller error. Per-call gasPrice is intentionally
 * deferred (cosmjs#1526 unresolved upstream) — use explicit `fee`.
 */
export interface TxCallOptions extends CallOptions {
  gasMultiplier?: number;
  fee?: StdFee;
  memo?: string;
  /**
   * Broadcast mode. `true`/absent (default) waits for block inclusion (cosmjs `signAndBroadcast`) and
   * returns the confirmed result. `false` broadcasts at Cosmos SYNC/CheckTx level (`signAndBroadcastSync`)
   * and returns as soon as the tx is accepted into the mempool — no block-inclusion wait. The result
   * still carries `transactionHash`, but `code`/`height` are PLACEHOLDERS (`0`/`''`) — NOT the DeliverTx
   * values, which do not exist yet — and `confirmed` is `false`. Use `false` to fire many txs without
   * serializing on N block confirmations; reconcile the on-chain outcome via the hash. (Consecutive
   * `false` broadcasts from one signer get consecutive sequences automatically — see `getBroadcastClient`
   * — so they do not collide.)
   */
  waitForConfirmation?: boolean;
}

/**
 * Ceiling on `CallOptions.timeout`, in ms (~24.8 days). NOT arbitrary: a timer delay is a
 * 32-bit signed integer, and a larger one does not fail — it emits a `TimeoutOverflowWarning`
 * and silently becomes **1 ms**, i.e. an instant deadline, the exact opposite of what the
 * caller asked for. Node accepts the whole uint32 range and only `RangeError`s above
 * `2**32`, so `[2**31, 2**32-1]` is a live silent-wrong-answer window (measured). The
 * `AbortSignal.timeout` IDL takes an `unsigned long long` with no `[EnforceRange]`, so a
 * browser COERCES rather than throwing — the same bad input would be loud in Node and
 * silently wrong in a bundle. Validating here makes the contract platform-independent,
 * which is why `core` (built `platform: "neutral"`) owns it rather than the runtime.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Merge a caller `signal` and a per-call `timeout` into one effective AbortSignal via
 * `AbortSignal.any`, so either source aborts the operation. A timeout abort reason is a
 * `TimeoutError` DOMException; a caller abort propagates the caller's reason — so callers
 * can distinguish "timed out" from "cancelled". Returns `undefined` when neither is set.
 *
 * Call this ONCE per operation and thread the result: a second call mints a second
 * `AbortSignal.timeout`, so the two legs would expire independently.
 *
 * THROWS `INVALID_CONFIG` on a malformed `timeout` — `AbortSignal.timeout` is strict, and
 * without this a `RangeError [ERR_OUT_OF_RANGE]` / `TypeError [ERR_INVALID_ARG_TYPE]` escapes
 * a helper documented as "merge two signals". The check runs BEFORE any signal is minted, so
 * the throw cannot leak an armed, process-pinned timer; and both seams resolve the signal
 * before doing anything, so a bad `timeout` consumes no rate-limit token and sends no tx.
 * `timeout: 0` is rejected too: it used to mint a deadline that fires on the next macrotask,
 * so the read never ran and the caller got a bare `TimeoutError` with nothing to explain it.
 *
 * `opts.signal` is deliberately NOT validated. A `null` signal is a type violation that this
 * guard has always dropped silently, and tightening it is a separate behaviour change.
 */
export function resolveCallSignal(opts?: CallOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (opts?.signal) signals.push(opts.signal);
  if (opts?.timeout !== undefined) {
    assertValidTimeout(opts.timeout);
    signals.push(AbortSignal.timeout(opts.timeout));
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * `Number.isInteger` alone rejects `NaN`, `±Infinity`, a float and every non-number
 * (a string `'500'` included), so the range check only has to carry the two ends.
 *
 * The diagnostic deliberately does NOT use `JSON.stringify`. It THROWS on a `bigint`, so a
 * JS caller passing `timeout: 1n` would leak the raw `TypeError` this guard exists to
 * replace — the exact defect class ENG-710 is about, reintroduced in the error path. It also
 * renders `NaN` and `±Infinity` as `null`, hiding the value that was actually rejected.
 * `String()` is total over every primitive (symbols included); quoting is reserved for
 * strings so `'500'` stays distinguishable from `500`.
 */
function assertValidTimeout(timeout: number): void {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    const shown =
      typeof timeout === 'string' ? `"${timeout}"` : String(timeout);
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms, got ${shown}`,
      { field: 'timeout', min: 1, max: MAX_TIMEOUT_MS },
    );
  }
}

/**
 * The value that represents an abort: the aborter's own reason, or the spec's default
 * `AbortError` when there is none.
 *
 * PRECONDITION — call this only once the signal is known aborted, from inside an `abort`
 * listener or under an `if (signal.aborted)` guard IN THE SAME FUNCTION. `reason` is
 * `undefined` on a LIVE signal, and reading it without that guard is precisely the defect
 * this exists to stop recurring: it produced `throw undefined`, which `withErrorHandling`
 * renders at the tool boundary as the literal message "undefined" (ENG-703).
 *
 * It deliberately does NOT self-check `signal.aborted` and substitute the default. That
 * variant is behaviour-identical at every current call site, and it manufactures a plausible
 * `AbortError` for a signal that never aborted — hiding exactly the misuse this helper exists
 * to surface. Do not re-add it.
 *
 * `??`, not `||`: an EMPTY-STRING reason is a value the caller CHOSE. Over MCP the abort
 * reason is `notification.params.reason`, typed `z.string().optional()`, so `''` is on the
 * wire and is carried verbatim like any other reason — this layer's contract is to propagate
 * the caller's value, not to improve it. The only reasons replaced are the ones carrying
 * nothing at all: `null` (the spec substitutes a default for `abort(undefined)` but NOT for
 * `abort(null)`) and `undefined` from a foreign or polyfilled signal.
 *
 * SCOPE — this is a SEAM helper, for the few places that AUTHOR the value a cancelled
 * operation rejects with (core's read seam, fred's provider transport, `abortableSleep`).
 * A leaf pre-flight guard keeps using the built-in `signal.throwIfAborted()`; note that the
 * built-in rethrows `reason` RAW, which is why the read seam does not use it (see
 * `internals/read-signal.ts`). Hoisted out of fred in ENG-710 so core, fred and any consumer
 * share one definition; `p-timeout`'s `getAbortedReason` is the same helper in the wild.
 */
export function abortReason(signal: AbortSignal | undefined): unknown {
  return (
    signal?.reason ??
    new DOMException('The operation was aborted', 'AbortError')
  );
}

/**
 * Sleep for `ms`, abort-aware. With no `signal` it is a plain `setTimeout` sleep; with one it
 * clears the timer and rejects with {@link abortReason} if the signal aborts before the sleep
 * ends (an already-aborted signal rejects without arming a timer at all).
 *
 * Rejects with the caller's OWN reason rather than wrapping it in an `AbortError` — the
 * WHATWG DOM convention, and the one this repo's read/transport layers follow. (Node's
 * `timers/promises.setTimeout` wraps instead; that is the tx-seam convention, applied one
 * layer up by `withTxConfirmation`.)
 *
 * Hoisted out of fred in ENG-710: core needs it for the cancellable rate-limit wait, and
 * fred's copy inlined a second, drifting version of `abortReason`'s fallback.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
