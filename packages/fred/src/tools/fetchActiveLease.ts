import {
  LeaseState,
  leaseStateToJSON,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import type { FredReadCtx } from '../ctx.js';
import { fetchLease } from './fetchLease.js';

/**
 * Fetches a lease by UUID, validates it exists and is in active/pending state.
 * Delegates existence to fetchLease (single not-found contract) and adds the
 * ACTIVE/PENDING gate. Throws ManifestMCPError if not found or not active.
 */
export async function fetchActiveLease(
  ctx: FredReadCtx,
  leaseUuid: string,
  action: string,
) {
  const lease = await fetchLease(ctx, leaseUuid);

  if (
    lease.state !== LeaseState.LEASE_STATE_ACTIVE &&
    lease.state !== LeaseState.LEASE_STATE_PENDING
  ) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" is not active (state: ${leaseStateToJSON(lease.state)}); ${action}`,
    );
  }

  return lease;
}
