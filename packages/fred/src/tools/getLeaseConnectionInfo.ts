import type { FredAuthCtx } from '../ctx.js';
import { getLeaseConnectionInfo as getLeaseConnectionInfoTransport } from '../http/provider.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

/** Resolve the provider URL, mint a provider token, fetch the lease connection info. */
export async function getLeaseConnectionInfo(
  ctx: FredAuthCtx,
  input: { address: string; leaseUuid: string; providerUuid: string },
) {
  const providerUrl = await resolveProviderUrl(ctx, input.providerUuid);
  const token = await ctx.providerAuth.providerToken({
    address: input.address,
    leaseUuid: input.leaseUuid,
  });
  return getLeaseConnectionInfoTransport(
    providerUrl,
    input.leaseUuid,
    token,
    ctx.fetch,
  );
}
