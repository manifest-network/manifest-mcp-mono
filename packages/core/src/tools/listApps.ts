import type { ManifestQueryClient } from '../client.js';

export type LeaseStateFilter = 'all' | 'pending' | 'active' | 'closed';

export interface LeaseInfo {
  readonly uuid: string;
  readonly state: number;
  readonly stateLabel: string;
  readonly providerUuid: string;
  readonly createdAt?: string;
  readonly closedAt?: string;
}

function leaseStateLabel(state: number): string {
  switch (state) {
    case 1: return 'pending';
    case 2: return 'active';
    case 3: return 'closed';
    default: return `unknown(${state})`;
  }
}

export async function listApps(
  queryClient: ManifestQueryClient,
  address: string,
  stateFilter: LeaseStateFilter = 'all',
): Promise<{ leases: LeaseInfo[]; count: number }> {
  const billing = queryClient.liftedinit.billing.v1;

  // Map filter to chain state codes
  const stateFilters: number[] =
    stateFilter === 'all' ? [1, 2, 3] :
    stateFilter === 'pending' ? [1] :
    stateFilter === 'active' ? [2] :
    [3]; // closed

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
