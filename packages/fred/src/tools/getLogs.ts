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
  const logEntries: Array<[service: string, log: string]> = [];
  let totalChars = 0;

  for (const [service, log] of Object.entries(result.logs)) {
    if (totalChars >= MAX_LOG_CHARS) {
      truncated = true;
      break;
    }

    // Service names are provider-controlled JSON keys and consume model context just like their
    // values. Never truncate a key: doing so can collide two services or attribute one service's
    // logs to another. Skip an over-budget entry and continue so a hostile first key cannot hide
    // every smaller, useful sibling.
    const remaining = MAX_LOG_CHARS - totalChars;
    if (service.length > remaining) {
      truncated = true;
      continue;
    }

    const valueBudget = remaining - service.length;
    const keptLog =
      log.length > valueBudget
        ? valueBudget > 0
          ? log.slice(-valueBudget)
          : ''
        : log;
    if (keptLog.length < log.length) truncated = true;

    logEntries.push([service, keptLog]);
    totalChars += service.length + keptLog.length;
  }

  return {
    lease_uuid: leaseUuid,
    // Object.fromEntries defines `__proto__` as an own data property. Assignment into `{}` would
    // invoke Object.prototype's legacy setter, lose the entry, and poison the length arithmetic.
    logs: Object.fromEntries(logEntries),
    truncated,
  };
}
