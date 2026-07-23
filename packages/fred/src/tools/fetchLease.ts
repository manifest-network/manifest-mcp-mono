import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import type { FredReadCtx } from '../ctx.js';

/**
 * Fetch a lease by UUID asserting only existence (ANY state). The state-agnostic
 * base primitive: `fetchActiveLease` composes this + a state gate, and
 * `restoreApp` / retention surfacing need a lease that may be CLOSED.
 */
export async function fetchLease(ctx: FredReadCtx, leaseUuid: string) {
  const leaseResult = await ctx.query.liftedinit.billing.v1.lease({ leaseUuid });
  if (!leaseResult.lease) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }
  return leaseResult.lease;
}
