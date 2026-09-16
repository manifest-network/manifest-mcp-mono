import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { SigningStargateClient, StargateClient } from '@cosmjs/stargate';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { isTransactionHash } from './transaction-hash.js';

const nativeBroadcast = StargateClient.prototype.broadcastTx;
const nativeBroadcastSync = StargateClient.prototype.broadcastTxSync;
const nativeSignAndBroadcast = SigningStargateClient.prototype.signAndBroadcast;
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

/** Add operation context while retaining an owned post-submission failure's cause chain. */
export function attributeBroadcastFailure(
  error: unknown,
  messagePrefix: string,
  details: Record<string, unknown>,
): ManifestMCPError | null {
  if (!isOwnedBroadcastFailure(error)) return null;
  return Object.defineProperty(
    new ManifestMCPError(error.code, `${messagePrefix}${error.message}`, {
      ...error.details,
      ...details,
    }),
    'cause',
    { value: error, configurable: true, writable: true },
  );
}

async function broadcastWithFailureGuard(
  client: SigningStargateClient,
  args: Parameters<SigningStargateClient['broadcastTx']>,
  onAccepted?: (transactionHash: string) => void,
) {
  // A consumer may replace the submission method after client creation. Its
  // returned value does not establish provenance for the native producer.
  if (client.broadcastTxSync !== nativeBroadcastSync)
    return nativeBroadcast.call(client, ...args);
  const view = Object.create(client) as SigningStargateClient;
  let acceptedHash: string | undefined;
  let hashMismatch: Error | undefined;
  view.broadcastTxSync = async (tx) => {
    // Hash the same snapshot passed to the native sender, not caller-owned bytes
    // that could change while CheckTx is in flight.
    const submittedTx = new Uint8Array(tx);
    const localHash = toHex(sha256(submittedTx)).toUpperCase();
    const reportedHash = await nativeBroadcastSync.call(client, submittedTx);
    acceptedHash = localHash;
    if (onAccepted) {
      try {
        // Observation cannot change submission, polling or native timer cleanup.
        void Promise.resolve(onAccepted(localHash)).catch(() => {});
      } catch {
        // A synchronous observer failure is likewise non-authoritative.
      }
    }
    if (
      !isTransactionHash(reportedHash) ||
      reportedHash.toUpperCase() !== localHash
    ) {
      hashMismatch = new Error(
        'RPC returned a transaction hash that does not match the submitted transaction bytes.',
      );
    }
    return reportedHash;
  };
  // Reject a mismatched ID before any real lookup. Throwing after SYNC returns
  // lets native polling clear its timer; throwing inside SYNC would skip cleanup.
  // Keep a customized query method's receiver and dynamic method lookup intact.
  view.getTx = (hash) => {
    if (hashMismatch) return Promise.reject(hashMismatch);
    return client.getTx(hash);
  };

  try {
    return await nativeBroadcast.call(view, ...args);
  } catch (error) {
    if (acceptedHash !== undefined)
      // The native deadline can expire before getTx; retain the known mismatch.
      throw ownedFailure(hashMismatch ?? error, acceptedHash);
    throw error;
  }
}

async function guardedBroadcast(
  this: SigningStargateClient,
  ...args: Parameters<SigningStargateClient['broadcastTx']>
) {
  return broadcastWithFailureGuard(this, args);
}

/** Observe only this native blocking call, without changing custom method receivers. */
export function signAndBroadcastWithObservation(
  client: SigningStargateClient,
  args: Parameters<SigningStargateClient['signAndBroadcast']>,
  onAccepted?: (transactionHash: string) => void,
) {
  if (
    !onAccepted ||
    client.signAndBroadcast !== nativeSignAndBroadcast ||
    client.broadcastTx !== guardedBroadcast ||
    client.broadcastTxSync !== nativeBroadcastSync
  )
    return client.signAndBroadcast(...args);

  const view = new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'broadcastTx' && value === guardedBroadcast) {
        return (
          ...broadcastArgs: Parameters<SigningStargateClient['broadcastTx']>
        ) => broadcastWithFailureGuard(target, broadcastArgs, onAccepted);
      }
      // Signing, simulation and queries keep the original raw/sequence receiver.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return nativeSignAndBroadcast.call(view, ...args);
}

/**
 * Install only on an SDK-created signing client. Keep CosmJS's signing and polling
 * implementations; bind accepted SYNC evidence to the submitted bytes' SHA-256
 * hash before preserving it on a later failure. A mismatched RPC hash fails before
 * any lookup, without discarding known submission. Neither a timeout's class nor
 * its fields establish submission.
 *
 * The method deliberately preserves dynamic `this`: sequence tracking invokes it on
 * Object.create(client) views. Submission state belongs to each call, never the client.
 * Returns whether this guard is installed, including an unchanged prior installation;
 * unsupported methods are left untouched.
 */
export function installBroadcastFailureGuard(
  client: SigningStargateClient,
): boolean {
  if (client.broadcastTxSync !== nativeBroadcastSync) return false;
  if (client.broadcastTx === guardedBroadcast) return true;
  if (client.broadcastTx !== nativeBroadcast) return false;

  Object.defineProperty(client, 'broadcastTx', {
    configurable: true,
    writable: true,
    value: guardedBroadcast,
  });
  return true;
}
