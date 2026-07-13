import type { FredAuthCtx } from '../ctx.js';
import { getLeaseLogs } from '../http/fred.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

const MAX_LOG_CHARS = 4000;

export async function getAppLogs(
  ctx: FredAuthCtx,
  input: { address: string; leaseUuid: string; tail?: number },
) {
  const { address, leaseUuid, tail } = input;
  const lease = await fetchActiveLease(
    ctx,
    leaseUuid,
    'logs are not available',
  );

  const providerUrl = await resolveProviderUrl(ctx, lease.providerUuid);
  const authToken = await ctx.providerAuth.providerToken({
    address,
    leaseUuid,
  });
  const result = await getLeaseLogs(
    providerUrl,
    leaseUuid,
    authToken,
    tail,
    ctx.fetch,
    ctx.allowLoopback,
  );

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
