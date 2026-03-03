import type { ManifestQueryClient } from '../client.js';
import { LeaseState, leaseStateToJSON } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';

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

export async function listApps(
  queryClient: ManifestQueryClient,
  address: string,
  stateFilter: LeaseStateFilter = 'all',
): Promise<{ leases: LeaseInfo[]; count: number }> {
  const billing = queryClient.liftedinit.billing.v1;

  // Map filter to chain state codes
  const stateFilterMap: Record<LeaseStateFilter, LeaseState[]> = {
    all: [LeaseState.LEASE_STATE_PENDING, LeaseState.LEASE_STATE_ACTIVE, LeaseState.LEASE_STATE_CLOSED, LeaseState.LEASE_STATE_REJECTED, LeaseState.LEASE_STATE_EXPIRED],
    pending: [LeaseState.LEASE_STATE_PENDING],
    active: [LeaseState.LEASE_STATE_ACTIVE],
    closed: [LeaseState.LEASE_STATE_CLOSED],
    rejected: [LeaseState.LEASE_STATE_REJECTED],
    expired: [LeaseState.LEASE_STATE_EXPIRED],
  };
  const stateFilters = stateFilterMap[stateFilter];

  const results = await Promise.all(
    stateFilters.map((sf) => billing.leasesByTenant({ tenant: address, stateFilter: sf })),
  );

  const leases: LeaseInfo[] = results
    .flatMap((r) => r.leases)
    .map((l) => ({
      uuid: l.uuid,
      state: l.state,
      stateLabel: leaseStateLabel(l.state),
      providerUuid: l.providerUuid,
      createdAt: l.createdAt?.toISOString(),
      closedAt: l.closedAt?.toISOString(),
    }));

  return { leases, count: leases.length };
}
