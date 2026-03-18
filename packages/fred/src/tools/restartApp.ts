import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import { restartLease } from '../http/fred.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export async function restartApp(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  fetchFn?: typeof globalThis.fetch,
) {
  const lease = await fetchActiveLease(
    queryClient,
    leaseUuid,
    'cannot be restarted',
  );

  const providerUrl = await resolveProviderUrl(queryClient, lease.providerUuid);
  const authToken = await getAuthToken(address, leaseUuid);
  const result = await restartLease(providerUrl, leaseUuid, authToken, fetchFn);

  return {
    lease_uuid: leaseUuid,
    status: result.status,
  };
}
