import type { ManifestQueryClient } from '../client.js';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { updateLease } from '../http/fred.js';
import { resolveLeaseProvider } from './resolveLeaseProvider.js';

export async function updateApp(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  manifest: string,
) {
  const { providerUrl, leaseState } = await resolveLeaseProvider(queryClient, leaseUuid);

  if (leaseState !== LeaseState.LEASE_STATE_ACTIVE && leaseState !== LeaseState.LEASE_STATE_PENDING) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" is not active (state: ${leaseState}) and cannot be updated`,
    );
  }

  const authToken = await getAuthToken(address, leaseUuid);
  const result = await updateLease(providerUrl, leaseUuid, manifest, authToken);

  return {
    lease_uuid: leaseUuid,
    status: result.status,
  };
}
