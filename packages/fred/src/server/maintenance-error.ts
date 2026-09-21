import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { ProviderApiError } from '../http/provider.js';

/** Expose legacy recovery guidance to MCP without changing the SDK error class. */
export function maintenanceToolError(
  error: unknown,
  leaseUuid: string,
  operation: 'restart' | 'update',
): unknown {
  try {
    if (!ProviderApiError.isProviderApiError(error)) return error;
    const cause = (error as Error & { cause?: unknown }).cause;
    if (
      cause instanceof ManifestMCPError &&
      cause.code === ManifestMCPErrorCode.MAINTENANCE_REQUEST_FAILED &&
      [error.details, cause.details].every(
        (details) =>
          details?.lease_uuid === leaseUuid &&
          details.operation === operation &&
          details.outcome === 'unknown' &&
          details.idempotency_key === undefined,
      )
    ) {
      return cause;
    }
  } catch {
    // A diagnostic getter must never replace the original failure.
  }
  return error;
}
