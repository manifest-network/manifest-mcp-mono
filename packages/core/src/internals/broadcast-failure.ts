import { type SigningStargateClient, StargateClient } from '@cosmjs/stargate';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const nativeBroadcast = StargateClient.prototype.broadcastTx;
const nativeBroadcastSync = StargateClient.prototype.broadcastTxSync;
const ownedBroadcastErrors = new WeakSet<object>();

/** Internal provenance for attribution; arbitrary SDK/transport errors cannot claim this marker. */
export function isOwnedBroadcastFailure(
  error: unknown,
): error is ManifestMCPError {
  return (
    typeof error === 'object' &&
    error !== null &&
    ownedBroadcastErrors.has(error)
  );
}

function validTransactionHash(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 64 &&
    !!value.match(/^[0-9a-fA-F]{64}$/)
  );
}

function failureCode(error: unknown): ManifestMCPErrorCode {
  try {
    if (
      error instanceof ManifestMCPError &&
      error.code === ManifestMCPErrorCode.OPERATION_CANCELLED
    )
      return ManifestMCPErrorCode.OPERATION_CANCELLED;
  } catch {
    // Unreadable diagnostics must not replace established submission evidence.
  }
  return ManifestMCPErrorCode.TX_FAILED;
}

function failureMessage(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Broadcast error message unavailable';
  }
}

function ownedFailure(
  error: unknown,
  transactionHash: string,
): ManifestMCPError {
  const normalized = new ManifestMCPError(
    failureCode(error),
    failureMessage(error),
    { sent: true, transactionHash },
  );
  Object.defineProperty(normalized, 'cause', {
    value: error,
    configurable: true,
    writable: true,
  });
  ownedBroadcastErrors.add(normalized);
  return normalized;
}

/**
 * Install only on an SDK-created signing client. Keep CosmJS's signing and polling
 * implementations; observe its accepted SYNC hash before preserving that evidence on
 * a later failure. Neither a timeout's class nor its fields establish submission.
 *
 * The method deliberately preserves dynamic `this`: sequence tracking invokes it on
 * Object.create(client) views. Submission state belongs to each call, never the client.
 */
export function installBroadcastFailureGuard(
  client: SigningStargateClient,
): void {
  if (
    client.broadcastTx !== nativeBroadcast ||
    client.broadcastTxSync !== nativeBroadcastSync
  )
    return;

  Object.defineProperty(client, 'broadcastTx', {
    configurable: true,
    writable: true,
    async value(
      this: SigningStargateClient,
      ...args: Parameters<SigningStargateClient['broadcastTx']>
    ) {
      // A consumer may replace the submission method after client creation. Its
      // returned value does not establish provenance for the native producer.
      if (this.broadcastTxSync !== nativeBroadcastSync)
        return nativeBroadcast.call(this, ...args);
      const view = Object.create(this) as SigningStargateClient;
      let acceptedHash: string | undefined;
      view.broadcastTxSync = async (tx) => {
        const hash = await nativeBroadcastSync.call(this, tx);
        if (validTransactionHash(hash)) acceptedHash = hash;
        return hash;
      };
      // Keep a customized query method's receiver and dynamic method lookup intact.
      view.getTx = (hash) => this.getTx(hash);

      try {
        return await nativeBroadcast.call(view, ...args);
      } catch (error) {
        if (acceptedHash !== undefined) throw ownedFailure(error, acceptedHash);
        throw error;
      }
    },
  });
}
