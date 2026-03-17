import type { ManifestQueryClient } from '@manifest-network/manifest-mcp-core';
import { getLeaseLogs } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { fetchActiveLease } from './fetchActiveLease.js';

const MAX_LOG_CHARS = 4000;

export async function getAppLogs(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  tail?: number,
  fetchFn?: typeof globalThis.fetch,
) {
  const lease = await fetchActiveLease(queryClient, leaseUuid, 'logs are not available');

  const providerUrl = await resolveProviderUrl(queryClient, lease.providerUuid);
  const authToken = await getAuthToken(address, leaseUuid);
  const result = await getLeaseLogs(providerUrl, leaseUuid, authToken, tail, fetchFn);

  let truncated = false;
  const logs: Record<string, string> = {};
  let totalChars = 0;

  for (const [service, log] of Object.entries(result.logs)) {
    if (totalChars >= MAX_LOG_CHARS) {
      truncated = true;
      break;
    }
    const remaining = MAX_LOG_CHARS - totalChars;
    if (log.length > remaining) {
      logs[service] = log.slice(-remaining);
      truncated = true;
    } else {
      logs[service] = log;
    }
    totalChars += logs[service].length;
  }

  return {
    lease_uuid: leaseUuid,
    logs,
    truncated,
  };
}
