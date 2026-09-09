import type { SigningStargateClient } from '@cosmjs/stargate';
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

/** Execution state shared by preparation, lock wait, retries, and the final submission boundary. */
export interface TxExecution {
  readonly signal: AbortSignal | undefined;
  checkpoint(): void;
  /** Call immediately before entering CosmJS's opaque signing/broadcast operation. */
  markBroadcast(): void;
}

/** Place the submission checkpoint after handler-owned preparation and gas simulation. */
export function guardTxClient(
  client: SigningStargateClient,
  execution: TxExecution,
): SigningStargateClient {
  if (!execution.signal) return client;
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (
        property === 'signAndBroadcast' ||
        property === 'signAndBroadcastSync'
      ) {
        return (
          ...args: Parameters<SigningStargateClient['signAndBroadcast']>
        ) => {
          execution.markBroadcast();
          return Reflect.apply(
            value as (...args: unknown[]) => unknown,
            target,
            args,
          );
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Resolve the operation deadline once and reject promptly on cancellation. Every awaited
 * preparation stage must checkpoint before continuing; markBroadcast performs the final check.
 * Before submission, cancellation reports sent:false and prevents later transmission. Once the
 * opaque CosmJS signing/broadcast operation starts, it cannot be cancelled safely: sent:true means
 * the outcome is unknown and must be reconciled. The losing promise remains observed.
 */
export async function withTxExecution<T>(
  operation: (execution: TxExecution) => Promise<T>,
  opts?: CallOptions,
): Promise<T> {
  const signal = resolveCallSignal(opts);
  let sent = false;
  const execution: TxExecution = {
    signal,
    checkpoint() {
      if (signal?.aborted) throw cancelledTxError(abortReason(signal), sent);
    },
    markBroadcast() {
      execution.checkpoint();
      sent = true;
    },
  };
  execution.checkpoint();
  if (signal === undefined) return operation(execution);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(cancelledTxError(abortReason(signal), sent));
    };
    // Register before invoking user/wallet code, which can synchronously abort the signal.
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      operation(execution).then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/**
 * Compatibility wrapper for an opaque broadcast callback: entering the callback means submission
 * may have begun. Preparation-aware callers use withTxExecution and mark the final boundary.
 */
export function withTxConfirmation<T>(
  broadcast: () => Promise<T>,
  opts?: CallOptions,
): Promise<T> {
  return withTxExecution((execution) => {
    execution.markBroadcast();
    return broadcast();
  }, opts);
}
