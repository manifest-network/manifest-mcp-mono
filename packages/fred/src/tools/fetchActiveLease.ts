import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import { LeaseState, leaseStateToJSON } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';

/**
 * Fetches a lease by UUID, validates it exists and is in active/pending state.
 * Throws ManifestMCPError if the lease is not found or not in an active state.
 */
export async function fetchActiveLease(
  queryClient: ManifestQueryClient,
  leaseUuid: string,
  action: string,
) {
  const leaseResult = await queryClient.liftedinit.billing.v1.lease({ leaseUuid });

  if (!leaseResult.lease) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }

  const lease = leaseResult.lease;

  if (lease.state !== LeaseState.LEASE_STATE_ACTIVE && lease.state !== LeaseState.LEASE_STATE_PENDING) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" is not active (state: ${leaseStateToJSON(lease.state)}); ${action}`,
    );
  }

  return lease;
}
