import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  resolveCallSignal,
} from '@manifest-network/manifest-mcp-core';
import type { ProgressEvent } from '../types.js';
import { emitProgress } from './safe-progress.js';

/**
 * Build the structured cancellation error for an aborted/timed-out PRE-broadcast
 * await (or a stopped-awaiting read). `OPERATION_CANCELLED` is non-retryable and
 * keeps the abort path consistent with the SDK error model; the original
 * `AbortError`/`TimeoutError` reason is preserved in the message + details.
 *
 * - `broadcasts: true`  → mutating flows (deploy / domain-set / lease-close):
 *   the abort happened before any tx was sent.
 * - `broadcasts: false` → read-only flows (troubleshoot / domain-lookup): there
 *   is no broadcast to reference; we merely stopped awaiting the query.
 */
export function cancelledError(
  reason: unknown,
  opLabel: string,
  broadcasts: boolean,
): ManifestMCPError {
  const detail = reason instanceof Error ? reason.message : String(reason);
  const message = broadcasts
    ? `${opLabel} was cancelled before broadcast (${detail}); no transaction was sent.`
    : `${opLabel} was cancelled (${detail}).`;
  return new ManifestMCPError(
    ManifestMCPErrorCode.OPERATION_CANCELLED,
    message,
    {
      reason,
    },
  );
}

/**
 * Race a pending promise against an `AbortSignal`. Copies the executor shape from core's
 * `internals/tx-confirmation.ts:withTxConfirmation`: the abort listener is added
 * `{ once: true }` and removed in `.finally`. The rejection error is produced by the
 * injected `makeError`, so the primitive stays operation-agnostic. Manifestjs queries take
 * no `AbortSignal`, so for read-only callers this does NOT cancel the RPC — it only stops
 * AWAITING it.
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  makeError: (reason: unknown) => ManifestMCPError,
): Promise<T> {
  if (signal.aborted) {
    // LOAD-BEARING, and the only one of its kind left in the repo (ENG-710): this early
    // return attaches no other handler to `promise`, so without this swallow the loser's
    // eventual rejection is genuinely unhandled. Its former twin below, and the two in
    // core's read/tx seams, were removed — there the `.then(resolve, reject)` in the
    // executor already marks the promise handled in the same tick. Do not "restore" them.
    promise.catch(() => {});
    return Promise.reject(makeError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(makeError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Per-call cancellation seam shared by all four agent-core orchestrators. */
export interface CancellationScope {
  /** Effective signal (caller `signal` composed with `timeout`), or `undefined`. */
  signal: AbortSignal | undefined;
  /** Throw `OPERATION_CANCELLED` (emitting `cancelled` once) if already aborted. */
  throwIfCancelled: () => void;
  /**
   * Race a pre-broadcast callback or a read query against the signal. A no-op
   * passthrough when no signal is present. On abort it emits `cancelled` once
   * and throws `OPERATION_CANCELLED`.
   */
  race: <T>(p: Promise<T>) => Promise<T>;
}

/**
 * Build the per-call cancellation seam: captures the resolved signal, a once-guard
 * for the terminal `cancelled` progress event, and the operation label /
 * broadcast-ness for the error message. SIDE-EFFECT-FREE at construction — call
 * `throwIfCancelled()` explicitly for the already-aborted short-circuit.
 *
 * It is no longer literally infallible, though: since ENG-710 `resolveCallSignal` rejects a
 * malformed `opts.timeout` with `INVALID_CONFIG`, so constructing a scope can throw. That is
 * fail-closed everywhere — all five construction sites run before any broadcast or provider
 * call — and a caller who mistypes a deadline now learns so instead of silently getting a 1ms
 * one. Do not "restore purity" by deferring the validation past a side effect.
 */
export function makeCancellationScope(args: {
  opts: { signal?: AbortSignal; timeout?: number };
  onProgress: ((event: ProgressEvent) => void) | undefined;
  opLabel: string;
  broadcasts: boolean;
}): CancellationScope {
  const { opts, onProgress, opLabel, broadcasts } = args;
  const signal = resolveCallSignal(opts);
  const makeError = (reason: unknown): ManifestMCPError =>
    cancelledError(reason, opLabel, broadcasts);
  let cancelledEmitted = false;
  const cancelOnAbort = (reason: unknown): never => {
    if (!cancelledEmitted) {
      cancelledEmitted = true;
      emitProgress(onProgress, { kind: 'cancelled' });
    }
    throw makeError(reason);
  };
  const throwIfCancelled = (): void => {
    if (signal?.aborted) cancelOnAbort(signal.reason);
  };
  const race = async <T>(p: Promise<T>): Promise<T> => {
    if (signal === undefined) return p;
    try {
      return await raceAbort(p, signal, makeError);
    } catch (err) {
      if (
        err instanceof ManifestMCPError &&
        err.code === ManifestMCPErrorCode.OPERATION_CANCELLED &&
        signal.aborted
      ) {
        cancelOnAbort(signal.reason);
      }
      throw err;
    }
  };
  return { signal, throwIfCancelled, race };
}
