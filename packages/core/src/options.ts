import type { StdFee } from '@cosmjs/stargate'; // type-only: erased at build, no runtime dep

/** Per-call options for typed READ building blocks. */
export interface CallOptions {
  /** Caller cancellation. Composed with `timeout` via AbortSignal.any. */
  signal?: AbortSignal;
  /** Per-call deadline in ms. Surfaces as a TimeoutError (distinct from the caller's AbortError). */
  timeout?: number;
}

/**
 * Per-call options for typed TRANSACTION building blocks. Fee precedence: an explicit
 * `fee` WINS (skips simulation / `gasMultiplier` / configured gasPrice — and is the one
 * path valid WITHOUT a configured gasPrice). `gasMultiplier` applies only on the simulate
 * path. Passing both is a caller error. Per-call gasPrice is intentionally deferred
 * (cosmjs#1526 unresolved upstream) — use explicit `fee`.
 */
export interface TxCallOptions extends CallOptions {
  gasMultiplier?: number;
  fee?: StdFee;
  memo?: string;
}

/**
 * Merge a caller `signal` and a per-call `timeout` into one effective AbortSignal via
 * `AbortSignal.any`, so either source aborts the operation. A timeout abort reason is a
 * `TimeoutError` DOMException; a caller abort propagates the caller's reason — so callers
 * can distinguish "timed out" from "cancelled". Returns `undefined` when neither is set.
 */
export function resolveCallSignal(opts?: CallOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (opts?.signal) signals.push(opts.signal);
  if (opts?.timeout !== undefined)
    signals.push(AbortSignal.timeout(opts.timeout));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}
