import type { ManifestQueryClient } from '../client.js';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { getLeaseStatus, type FredLeaseStatus } from '../http/fred.js';
import { getLeaseConnectionInfo, type LeaseConnectionInfo } from '../http/provider.js';
import { resolveLeaseProvider } from './resolveLeaseProvider.js';

export async function appStatus(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
) {
  const leaseResult = await queryClient.liftedinit.billing.v1.lease({ leaseUuid });

  if (!leaseResult.lease) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }

  const lease = leaseResult.lease;
  const chainState = {
    state: lease.state,
    providerUuid: lease.providerUuid,
    createdAt: lease.createdAt?.toISOString(),
    closedAt: lease.closedAt?.toISOString(),
  };

  let fredStatus: FredLeaseStatus | null = null;
  let connection: LeaseConnectionInfo | null = null;
  let providerError: string | undefined;
  let connectionError: string | undefined;

  if (lease.state === LeaseState.LEASE_STATE_PENDING || lease.state === LeaseState.LEASE_STATE_ACTIVE) {
    const leaseProvider = await resolveLeaseProvider(queryClient, leaseUuid);
    const authToken = await getAuthToken(address, leaseUuid);

    const [statusResult, connResult] = await Promise.allSettled([
      getLeaseStatus(leaseProvider.providerUrl, leaseUuid, authToken),
      getLeaseConnectionInfo(leaseProvider.providerUrl, leaseUuid, authToken),
    ]);

    if (statusResult.status === 'fulfilled') {
      fredStatus = statusResult.value;
    } else {
      providerError = statusResult.reason instanceof Error ? statusResult.reason.message : String(statusResult.reason);
    }

    if (connResult.status === 'fulfilled') {
      connection = connResult.value;
    } else {
      connectionError = connResult.reason instanceof Error ? connResult.reason.message : String(connResult.reason);
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
