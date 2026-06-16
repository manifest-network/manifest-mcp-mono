import { type CallOptions, resolveCallSignal } from '../options.js';

/**
 * Bound the AWAIT of a broadcast+confirmation with the caller's effective AbortSignal (opts.signal + opts.timeout).
 * CRITICAL: a submitted tx CANNOT be un-broadcast (cosmjs's signAndBroadcast combines broadcast + the commit
 * poll and accepts no AbortSignal). This PRE-CHECKS `sig.aborted` BEFORE calling `broadcast` (an already-aborted
 * call sends NOTHING), then races the broadcast() promise vs abort. Once broadcast() is called the tx is sent;
 * an abort/timeout stops you AWAITING and surfaces AbortError/TimeoutError, but the tx MAY STILL COMMIT (the
 * losing broadcast() runs to completion in the background, its result discarded) — the signal bounds your wait,
 * NOT the broadcast; a caller who aborts must re-query the chain. Does NOT acquireRateLimit (cosmosTx does that).
 * A timeout rejects TimeoutError; a caller abort propagates the caller's reason.
 * NOTE: `broadcast` here is the WHOLE cosmosTx call (acquireRateLimit → getSigningClient → simulate → signAndBroadcast),
 * so an abort racing the early window (acquire/getSigningClient/simulate, BEFORE the wire send) ALSO surfaces
 * AbortError even though NO tx was sent. The caller cannot distinguish "aborted pre-send" from "aborted post-send,
 * still committing" from this seam — hence the conservative contract: on abort, treat the outcome as UNKNOWN and re-query.
 */
export async function withTxConfirmation<T>(
  broadcast: () => Promise<T>,
  opts?: CallOptions,
): Promise<T> {
  const signal = resolveCallSignal(opts);
  if (signal === undefined) return broadcast();
  if (signal.aborted) throw signal.reason; // BEFORE broadcast — no tx sent
  const p = broadcast();
  p.catch(() => {}); // swallow the losing branch's eventual rejection
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', onAbort),
    );
  });
}
