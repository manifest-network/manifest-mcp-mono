import type { FredAuthCtx } from '../ctx.js';
import { restartLease } from '../http/fred.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export async function restartApp(
  ctx: FredAuthCtx,
  input: { address: string; leaseUuid: string },
) {
  const { address, leaseUuid } = input;
  const lease = await fetchActiveLease(
    ctx.query,
    leaseUuid,
    'cannot be restarted',
  );

  const providerUrl = await resolveProviderUrl(ctx.query, lease.providerUuid);
  const authToken = await ctx.providerAuth.providerToken({
    address,
    leaseUuid,
  });
  const result = await restartLease(
    providerUrl,
    leaseUuid,
    authToken,
    ctx.fetch,
  );

  return {
    lease_uuid: leaseUuid,
    status: result.status,
  };
}
