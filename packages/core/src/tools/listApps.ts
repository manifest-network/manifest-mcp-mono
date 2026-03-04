import type { ManifestQueryClient } from '../client.js';
import { LeaseState, leaseStateToJSON } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';

export type LeaseStateFilter = 'all' | 'pending' | 'active' | 'closed' | 'rejected' | 'expired';

export interface LeaseInfo {
  readonly uuid: string;
  readonly state: LeaseState;
  readonly stateLabel: string;
  readonly providerUuid: string;
  readonly createdAt?: string;
  readonly closedAt?: string;
}

function leaseStateLabel(state: LeaseState): string {
  switch (state) {
    case LeaseState.LEASE_STATE_PENDING: return 'pending';
    case LeaseState.LEASE_STATE_ACTIVE: return 'active';
    case LeaseState.LEASE_STATE_CLOSED: return 'closed';
    case LeaseState.LEASE_STATE_REJECTED: return 'rejected';
    case LeaseState.LEASE_STATE_EXPIRED: return 'expired';
    default: return leaseStateToJSON(state).toLowerCase();
  }
}

// Map user-facing filter to chain LeaseState enum.
// LEASE_STATE_UNSPECIFIED (0) means "no filter" — returns all states in one query.
const stateFilterMap: Record<LeaseStateFilter, LeaseState> = {
  all: LeaseState.LEASE_STATE_UNSPECIFIED,
  pending: LeaseState.LEASE_STATE_PENDING,
  active: LeaseState.LEASE_STATE_ACTIVE,
  closed: LeaseState.LEASE_STATE_CLOSED,
  rejected: LeaseState.LEASE_STATE_REJECTED,
  expired: LeaseState.LEASE_STATE_EXPIRED,
};

export async function listApps(
  queryClient: ManifestQueryClient,
  address: string,
  stateFilter: LeaseStateFilter = 'all',
): Promise<{ leases: LeaseInfo[]; count: number }> {
  const billing = queryClient.liftedinit.billing.v1;

  const result = await billing.leasesByTenant({
    tenant: address,
    stateFilter: stateFilterMap[stateFilter],
  });

  const leases: LeaseInfo[] = result.leases.map((l) => ({
    uuid: l.uuid,
    state: l.state,
    stateLabel: leaseStateLabel(l.state),
    providerUuid: l.providerUuid,
    createdAt: l.createdAt?.toISOString(),
    closedAt: l.closedAt?.toISOString(),
  }));

  return { leases, count: leases.length };
}
