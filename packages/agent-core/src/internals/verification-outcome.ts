import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type SetItemCustomDomainResult,
  type StopAppResult,
} from '@manifest-network/manifest-mcp-core';

type MutationReceipt = SetItemCustomDomainResult | StopAppResult;

function withCause(error: ManifestMCPError, cause: unknown): ManifestMCPError {
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    writable: true,
  });
  return error;
}

export function verificationQueryError(
  reason: string,
  cause: unknown,
): ManifestMCPError {
  return withCause(
    new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, reason),
    cause,
  );
}

/** Preserve reconciliation evidence across every failure after a mutation result. */
export async function withVerificationOutcome<T>(
  receipt: MutationReceipt,
  verify: () => Promise<T>,
): Promise<T> {
  try {
    return await verify();
  } catch (cause) {
    const error =
      cause instanceof ManifestMCPError
        ? cause
        : verificationQueryError(
            `Post-mutation verification failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          );
    const outcome = {
      lease_uuid: receipt.lease_uuid,
      ...('transactionHash' in receipt
        ? {
            sent: true,
            transaction_hash: receipt.transactionHash,
            transaction_confirmed: receipt.confirmed,
            ...('code' in receipt ? { transaction_code: receipt.code } : {}),
          }
        : {}),
      ...('outcome' in receipt
        ? { stop_outcome: receipt.outcome, lease_state: receipt.lease_state }
        : {
            service_name: receipt.service_name,
            custom_domain: receipt.custom_domain,
          }),
    };
    const details: Record<string, unknown> = {
      // Keep receipt fields first for bounded MCP output, and authoritative
      // even when the later query supplies conflicting details.
      ...outcome,
      ...error.details,
      ...outcome,
    };
    if ('transactionHash' in receipt && !('code' in receipt)) {
      // An unconfirmed stop receipt supplies no code. Do not attach a query's
      // unrelated code to this transaction hash; it remains available in cause.
      delete details.transaction_code;
    }
    throw withCause(
      new ManifestMCPError(error.code, error.message, details),
      error,
    );
  }
}
