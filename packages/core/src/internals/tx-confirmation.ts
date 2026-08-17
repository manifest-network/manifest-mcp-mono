import {
  abortReason,
  type CallOptions,
  resolveCallSignal,
} from '../options.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/**
 * Build the structured cancellation error for an aborted/timed-out tx await. Surfacing a
 * `ManifestMCPError(OPERATION_CANCELLED)` (rather than the raw `AbortError`/`TimeoutError` DOMException)
 * keeps the abort path consistent with the rest of the SDK error model — consumers branch on
 * `instanceof ManifestMCPError` / `code` uniformly — and OPERATION_CANCELLED is non-retryable, so a retry
 * layer never blindly re-broadcasts (code-review PR #102). The original reason is preserved in `details`.
 * `sent` distinguishes the unambiguous pre-broadcast case (nothing sent) from the post-broadcast race
 * (the tx MAY have committed → re-query, do not blindly retry). It is also surfaced in `details.sent` so a
 * consumer can branch on it programmatically (`sent === false` ⇒ safe to retry) without parsing the message.
 */
function cancelledTxError(reason: unknown, sent: boolean): ManifestMCPError {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return new ManifestMCPError(
    ManifestMCPErrorCode.OPERATION_CANCELLED,
    sent
      ? `Transaction await was cancelled (${detail}); the broadcast may still commit on-chain — re-query the chain before retrying (do NOT blindly retry).`
      : `Transaction was cancelled before broadcast (${detail}); no transaction was sent.`,
    { reason, sent },
  );
}

/**
 * Bound the AWAIT of a broadcast+confirmation with the caller's effective AbortSignal (opts.signal + opts.timeout).
 * CRITICAL: a submitted tx CANNOT be un-broadcast (cosmjs's signAndBroadcast combines broadcast + the commit
 * poll and accepts no AbortSignal). This PRE-CHECKS `sig.aborted` BEFORE calling `broadcast` (an already-aborted
 * call sends NOTHING), then races the broadcast() promise vs abort. Once broadcast() is called the tx is sent;
 * an abort/timeout stops you AWAITING and surfaces AbortError/TimeoutError, but the tx MAY STILL COMMIT (the
 * losing broadcast() runs to completion in the background, its result discarded) — the signal bounds your wait,
 * NOT the broadcast; a caller who aborts must re-query the chain. Does NOT acquireRateLimit (cosmosTx does that).
 * A timeout rejects TimeoutError; a caller abort propagates the caller's reason.
 * CONVENTION — this seam WRAPS (unlike the read seam in `read-signal.ts`, which rejects with the raw
 * reason). Both are legitimate: rejecting with the signal's own reason is what the WHATWG DOM asks of
 * an API that accepts an `AbortSignal`, while wrapping and demoting the original to a `cause`/`details`
 * slot is what Node's own promise APIs do. The split is per layer, chosen by whether the cancelled
 * operation could have left something behind — a broadcast can, so its outcome needs a structured,
 * non-retryable code and a `sent` flag. It is not an inconsistency to unify.
 * NOTE: `broadcast` here is the WHOLE cosmosTx call (getBroadcastClient → per attempt: acquireRateLimit →
 * simulate → signAndBroadcast; the client is acquired once, outside the retry ladder — ENG-679),
 * so an abort racing the early window (client acquisition/acquire/simulate, BEFORE the wire send) ALSO surfaces
 * AbortError even though NO tx was sent. The caller cannot distinguish "aborted pre-send" from "aborted post-send,
 * still committing" from this seam — hence the conservative contract: on abort, treat the outcome as UNKNOWN and re-query.
 */
export async function withTxConfirmation<T>(
  broadcast: () => Promise<T>,
  opts?: CallOptions,
): Promise<T> {
  const signal = resolveCallSignal(opts);
  if (signal === undefined) return broadcast();
  // `abortReason` normalizes a reason carrying nothing at all, so `details.reason` and the
  // interpolated message can never read "null"/"undefined" (ENG-710); a reason the caller
  // actually chose — an empty string included — is preserved verbatim inside the wrapper.
  if (signal.aborted) throw cancelledTxError(abortReason(signal), false); // BEFORE broadcast — no tx sent
  const p = broadcast();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledTxError(abortReason(signal), true)); // tx MAY have committed
    signal.addEventListener('abort', onAbort, { once: true });
    // No `p.catch(() => {})` swallow: `.then(resolve, reject)` below is attached synchronously
    // in this same tick, so the losing broadcast's late rejection is already handled and never
    // reaches `unhandledRejection` (verified, ENG-710).
    p.then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', onAbort),
    );
  });
}
