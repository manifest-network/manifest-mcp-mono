import type { EncodeObject } from '@cosmjs/proto-signing';
import type {
  DeliverTxResponse,
  SigningStargateClient,
  StdFee,
} from '@cosmjs/stargate';

/**
 * Per-signer local sequence tracking for non-blocking (SYNC / CheckTx) broadcasts.
 *
 * cosmjs `signAndBroadcast`/`signAndBroadcastSync` read the signer's sequence from the **committed**
 * chain state (`getSequence`) at sign time. That is correct for the blocking path — it waits for block
 * inclusion, so the committed sequence has advanced before the next broadcast reads it (this is exactly
 * what the per-signer `withBroadcastLock` relies on, see `client.ts`). But a SYNC broadcast returns
 * after CheckTx, BEFORE inclusion, so N consecutive sync broadcasts from one signer would all read the
 * SAME committed sequence and collide (`account sequence mismatch` on tx 2..N) — defeating the entire
 * point of firing a batch without serializing on block confirmations.
 *
 * This module tracks the "next unused sequence" per signer locally and injects it so consecutive sync
 * broadcasts use consecutive sequences. It reuses cosmjs's real broadcast pipeline (fee/`'auto'`
 * resolution, `simulate`, `sign`, `broadcastTx`/`broadcastTxSync`) and only shadows `getSequence` via an
 * `Object.create` view — no reimplementation of signing/fee logic.
 */
export interface CachedSequence {
  accountNumber: number;
  sequence: number;
}

/** Keyed by signer address. One entry only while a signer has an unconfirmed sync broadcast in flight. */
export type SequenceCache = Map<string, CachedSequence>;

type BroadcastArgs = [
  sender: string,
  messages: readonly EncodeObject[],
  fee: StdFee | 'auto' | number,
  memo?: string,
];

async function managedBroadcast(
  real: SigningStargateClient,
  cache: SequenceCache,
  wait: boolean,
  sender: string,
  messages: readonly EncodeObject[],
  fee: StdFee | 'auto' | number,
  memo: string,
): Promise<DeliverTxResponse | string> {
  const cached = cache.get(sender);

  // Fast path — a blocking broadcast with no unconfirmed sync tx in flight keeps cosmjs's exact
  // behavior: read the committed sequence and wait for inclusion. Nothing to track or invalidate.
  if (wait && !cached) {
    return real.signAndBroadcast(sender, messages, fee, memo);
  }

  // Seed the local counter from committed state on first use.
  const seq: CachedSequence = cached ?? (await real.getSequence(sender));
  if (!cached) cache.set(sender, seq);

  // A per-broadcast VIEW of the real client that signs with our tracked sequence. `Object.create`
  // inherits every field/method (signer, gasPrice, cometClient, `simulate`, `sign`, `broadcastTx`…), so
  // cosmjs still does all the real work; only `getSequence` is shadowed. Concurrency-safe: a fresh view
  // per broadcast, no mutation of the shared client (distinct signers use distinct cache entries and
  // distinct broadcast locks).
  const view = Object.create(real) as SigningStargateClient & {
    getSequence: SigningStargateClient['getSequence'];
  };
  view.getSequence = async () => ({
    accountNumber: seq.accountNumber,
    sequence: seq.sequence,
  });

  try {
    const result = wait
      ? await real.signAndBroadcast.call(view, sender, messages, fee, memo)
      : await real.signAndBroadcastSync.call(view, sender, messages, fee, memo);
    // A tx that passes CheckTx consumes its sequence even if it later fails in DeliverTx, so advancing
    // here is correct for both the blocking and sync outcomes.
    seq.sequence += 1;
    // A blocking broadcast waited for inclusion → committed state is authoritative again → drop the
    // local counter so the next broadcast re-reads a fresh sequence (bounds drift to a single burst).
    if (wait) cache.delete(sender);
    return result;
  } catch (err) {
    // Reset on ANY failure (CheckTx rejection, network error, …). The submitted-but-rejected tx did not
    // consume the sequence, so the next broadcast must re-read the committed state rather than trust a
    // possibly-drifted local counter. Self-heals a stale counter within one extra broadcast.
    cache.delete(sender);
    throw err;
  }
}

/**
 * Wrap a `SigningStargateClient` so its `signAndBroadcast`/`signAndBroadcastSync` use per-signer local
 * sequence tracking (see module doc). Every other method delegates unchanged to the real client. The
 * caller must serialize broadcasts per signer (the SDK does, via `withBroadcastLock`).
 */
export function sequencedSigningClient(
  real: SigningStargateClient,
  cache: SequenceCache,
): SigningStargateClient {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'signAndBroadcast') {
        return (...args: BroadcastArgs) =>
          managedBroadcast(
            target,
            cache,
            true,
            args[0],
            args[1],
            args[2],
            args[3] ?? '',
          );
      }
      if (prop === 'signAndBroadcastSync') {
        return (...args: BroadcastArgs) =>
          managedBroadcast(
            target,
            cache,
            false,
            args[0],
            args[1],
            args[2],
            args[3] ?? '',
          );
      }
      const value = Reflect.get(target, prop, receiver);
      // Bind functions to the real client so their internal `this` is intact.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
