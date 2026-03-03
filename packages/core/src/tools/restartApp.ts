import type { ManifestQueryClient } from '../client.js';
import { LeaseState, leaseStateToJSON } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { restartLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export async function restartApp(
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

  if (lease.state !== LeaseState.LEASE_STATE_ACTIVE && lease.state !== LeaseState.LEASE_STATE_PENDING) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" is not active (state: ${leaseStateToJSON(lease.state)}) and cannot be restarted`,
    );
  }

  const providerUrl = await resolveProviderUrl(queryClient, lease.providerUuid);
  const authToken = await getAuthToken(address, leaseUuid);
  const result = await restartLease(providerUrl, leaseUuid, authToken);

  return {
    lease_uuid: leaseUuid,
    status: result.status,
  };
}
