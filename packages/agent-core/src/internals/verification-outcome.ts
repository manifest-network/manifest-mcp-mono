import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type SetItemCustomDomainResult,
  type StopAppResult,
  sanitizeForModelText,
} from '@manifest-network/manifest-mcp-core';

type MutationReceipt = SetItemCustomDomainResult | StopAppResult;

// Match the MCP projection's case/separator equivalence for reserved receipt
// names and their native receipt aliases. Generic code/hash diagnostics remain.
const RECEIPT_DETAIL_NAMES = new Set([
  'leaseuuid',
  'sent',
  'transactionhash',
  'txhash',
  'transactionconfirmed',
  'confirmed',
  'transactioncode',
  'stopoutcome',
  'outcome',
  'leasestate',
  'servicename',
  'customdomain',
  'rejectionreason', // Free-form provider prose is never receipt metadata.
]);

function isReceiptDetailName(key: string): boolean {
  return RECEIPT_DETAIL_NAMES.has(key.toLowerCase().replace(/[_-]/g, ''));
}

function verificationDetails(error: ManifestMCPError): Record<string, unknown> {
  try {
    return Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(error.details ?? {}))
        .filter(
          ([, descriptor]) => descriptor.enumerable && 'value' in descriptor,
        )
        .map(([key, descriptor]) => [key, descriptor.value]),
    );
  } catch {
    // Diagnostic inspection must not discard an established mutation receipt.
    return {};
  }
}

function withCause(error: ManifestMCPError, cause: unknown): ManifestMCPError {
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    writable: true,
  });
  return error;
}

/** Error inspection must not replace the original verification failure. */
export function verificationErrorMessage(cause: unknown): string {
  try {
    return cause instanceof Error ? String(cause.message) : String(cause);
  } catch {
    return 'Verification error message unavailable';
  }
}

function verificationErrorCode(error: ManifestMCPError): ManifestMCPErrorCode {
  try {
    return error.code;
  } catch {
    return ManifestMCPErrorCode.QUERY_FAILED;
  }
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

function normalizeVerificationError(cause: unknown): ManifestMCPError {
  try {
    if (cause instanceof ManifestMCPError) return cause;
  } catch {
    // Even a failed prototype inspection must preserve the thrown value.
  }
  return verificationQueryError(
    `Post-mutation verification failed: ${verificationErrorMessage(cause)}`,
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
    const error = normalizeVerificationError(cause);
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
      ...verificationDetails(error),
      ...outcome,
    };
    for (const key of Object.keys(details)) {
      // Do not attribute another operation's receipt fields to this result.
      // Its submission/partial-outcome vetoes remain in the original cause.
      if (
        (isReceiptDetailName(key) ||
          isReceiptDetailName(sanitizeForModelText(key, 128))) &&
        Object.getOwnPropertyDescriptor(outcome, key) === undefined
      ) {
        delete details[key];
      }
    }
    throw withCause(
      new ManifestMCPError(
        verificationErrorCode(error),
        verificationErrorMessage(error),
        details,
      ),
      error,
    );
  }
}
