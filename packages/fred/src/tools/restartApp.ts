import type { FredAuthCtx } from '../ctx.js';
import {
  type FredLeaseStatus,
  pollLeaseUntilReady,
  restartLease,
} from '../http/fred.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import type { LifecycleCallOptions } from './lifecycle-options.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export async function restartApp(
  ctx: FredAuthCtx,
  input: { address: string; leaseUuid: string },
  opts: LifecycleCallOptions = {},
): Promise<{ lease_uuid: string; status: string; ready?: FredLeaseStatus }> {
  const { address, leaseUuid } = input;
  opts.abortSignal?.throwIfAborted();

  // Fast path: a supplied providerUrl skips both on-chain queries (fetchActiveLease + resolveProviderUrl).
  let providerUrl: string;
  if (opts.providerUrl) {
    providerUrl = opts.providerUrl;
  } else {
    const lease = await fetchActiveLease(ctx, leaseUuid, 'cannot be restarted');
    providerUrl = await resolveProviderUrl(ctx, lease.providerUuid);
  }

  const authToken = await ctx.providerAuth.providerToken({
    address,
    leaseUuid,
  });
  // Final check immediately before the non-idempotent mutate POST: an abort during the
  // (slow-path) providerUrl resolution / token mint must not still fire the restart.
  opts.abortSignal?.throwIfAborted();
  const result = await restartLease(
    providerUrl,
    leaseUuid,
    authToken,
    ctx.fetch,
    ctx.allowLoopback,
  );
  const base = { lease_uuid: leaseUuid, status: result.status };

  if (opts.pollOptions === false) return base;
  const ready = await pollLeaseUntilReady(
    providerUrl,
    leaseUuid,
    () => ctx.providerAuth.providerToken({ address, leaseUuid }),
    { ...opts.pollOptions, abortSignal: opts.abortSignal },
    ctx.fetch,
    ctx.allowLoopback,
  );
  return { ...base, ready };
}
