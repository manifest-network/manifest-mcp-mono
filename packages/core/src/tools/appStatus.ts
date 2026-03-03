import type { ManifestQueryClient } from '../client.js';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';
import { getLeaseStatus, type FredLeaseStatus } from '../http/fred.js';
import { getLeaseConnectionInfo, type LeaseConnectionInfo } from '../http/provider.js';
import { resolveLeaseProvider } from './resolveLeaseProvider.js';

export async function appStatus(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
) {
  const leaseProvider = await resolveLeaseProvider(queryClient, leaseUuid);

  const chainState = {
    state: leaseProvider.leaseState,
    providerUuid: leaseProvider.providerUuid,
    createdAt: leaseProvider.leaseCreatedAt,
    closedAt: leaseProvider.leaseClosedAt,
  };

  let fredStatus: FredLeaseStatus | null = null;
  let connection: LeaseConnectionInfo | null = null;
  let providerError: string | undefined;
  let connectionError: string | undefined;

  if (leaseProvider.leaseState === LeaseState.LEASE_STATE_PENDING || leaseProvider.leaseState === LeaseState.LEASE_STATE_ACTIVE) {
    const authToken = await getAuthToken(address, leaseUuid);

    try {
      fredStatus = await getLeaseStatus(leaseProvider.providerUrl, leaseUuid, authToken);
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
    }

    try {
      connection = await getLeaseConnectionInfo(leaseProvider.providerUrl, leaseUuid, authToken);
    } catch (err) {
      connectionError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    lease_uuid: leaseUuid,
    ...(connection && { connection }),
    chainState,
    ...(fredStatus && { fredStatus }),
    ...(providerError && { providerError }),
    ...(connectionError && { connectionError }),
  };
}
