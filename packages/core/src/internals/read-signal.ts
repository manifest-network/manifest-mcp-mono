import type { ReadCtx } from '../ctx.js';
import { type CallOptions, resolveCallSignal } from '../options.js';

/**
 * Race a manifestjs read against the caller's effective AbortSignal (composed from `opts.signal` +
 * `opts.timeout` via `resolveCallSignal`). Pre-checks `sig.aborted` BEFORE `acquireRateLimit` so an
 * already-aborted call consumes neither a rate-limit token nor a connection, and RE-checks after the
 * (possibly-blocking) token wait. NOTE: manifestjs query methods accept NO AbortSignal — the underlying
 * RPC is NOT truly cancelled (fire-and-forget); we only stop AWAITING it. A timeout rejects with the
 * TimeoutError DOMException from AbortSignal.timeout; a caller abort propagates the caller's reason
 * (AbortError by default) — so callers distinguish "timed out" from "cancelled".
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
  if (signal.aborted) throw signal.reason;
  await ctx.chain.acquireRateLimit(); // can BLOCK; the deadline may elapse during this await
  if (signal.aborted) throw signal.reason; // double-precheck after the token wait
  const readPromise = read();
  readPromise.catch(() => {}); // swallow the losing branch's eventual rejection (fire-and-forget)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    readPromise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}
