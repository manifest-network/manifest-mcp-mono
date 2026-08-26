import type { FredAuthCtx } from '../ctx.js';
import { getLeaseLogs } from '../http/fred.js';
import { hadValidationDrops } from '../http/response-schemas.js';
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

  let truncated = hadValidationDrops(result.logs);
  const sourceEntries = Object.entries(result.logs);
  const allocations = new Map<number, number>();
  let unsettled = sourceEntries.map((_, index) => index);
  let remainingBudget = MAX_LOG_CHARS;

  // Max-min fair allocation: fully satisfy small services first, redistribute their unused share,
  // then split the remainder across large services. Keys are indivisible; a key that cannot fit
  // its fair share is dropped rather than truncated, so it cannot collide with another service or
  // starve every useful sibling.
  while (unsettled.length > 0) {
    const share = Math.floor(remainingBudget / unsettled.length);
    const satisfied = unsettled.filter((index) => {
      const [service, log] = sourceEntries[index] as [string, string];
      return service.length + log.length <= share;
    });

    if (satisfied.length > 0) {
      const satisfiedSet = new Set(satisfied);
      for (const index of satisfied) {
        const [service, log] = sourceEntries[index] as [string, string];
        const cost = service.length + log.length;
        allocations.set(index, cost);
        remainingBudget -= cost;
      }
      unsettled = unsettled.filter((index) => !satisfiedSet.has(index));
      continue;
    }

    const impossibleKeys = unsettled.filter((index) => {
      const [service] = sourceEntries[index] as [string, string];
      return service.length > share;
    });
    if (impossibleKeys.length > 0) {
      const impossibleSet = new Set(impossibleKeys);
      unsettled = unsettled.filter((index) => !impossibleSet.has(index));
      truncated = true;
      continue;
    }

    const remainder = remainingBudget % unsettled.length;
    for (const [position, index] of unsettled.entries()) {
      allocations.set(index, share + (position < remainder ? 1 : 0));
    }
    break;
  }

  const logEntries: Array<[service: string, log: string]> = [];
  for (const [index, [service, log]] of sourceEntries.entries()) {
    const allocation = allocations.get(index);
    if (allocation === undefined) continue;
    const valueBudget = allocation - service.length;
    const keptLog =
      log.length > valueBudget
        ? valueBudget > 0
          ? log.slice(-valueBudget)
          : ''
        : log;
    if (keptLog.length < log.length) truncated = true;
    logEntries.push([service, keptLog]);
  }

  return {
    lease_uuid: leaseUuid,
    // Object.fromEntries defines `__proto__` as an own data property. Assignment into `{}` would
    // invoke Object.prototype's legacy setter, lose the entry, and poison the length arithmetic.
    logs: Object.fromEntries(logEntries),
    truncated,
  };
}
