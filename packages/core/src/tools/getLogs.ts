import type { ManifestQueryClient } from '../client.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { getLeaseLogs } from '../http/fred.js';
import { resolveLeaseProvider } from './resolveLeaseProvider.js';

const MAX_LOG_CHARS = 4000;

export async function getAppLogs(
  queryClient: ManifestQueryClient,
  address: string,
  leaseUuid: string,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
  tail?: number,
) {
  const { providerUrl, leaseState } = await resolveLeaseProvider(queryClient, leaseUuid);

  if (leaseState === 3) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" is closed; logs are no longer available`,
    );
  }

  const authToken = await getAuthToken(address, leaseUuid);
  const result = await getLeaseLogs(providerUrl, leaseUuid, authToken, tail);

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
