import type { FredAuthCtx } from '../ctx.js';
import {
  type FredLeaseStatus,
  pollLeaseUntilReady,
  restartLease,
} from '../http/fred.js';
import { validateProviderUrl } from '../http/provider.js';
import { resolveMaintenanceIdempotencyKey } from '../maintenance.js';
import {
  maintenanceError,
  maintenanceWaitError,
} from '../maintenance-error.js';
import { resolveFredSignal } from './call-signal.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import type { LifecycleCallOptions } from './lifecycle-options.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export async function restartApp(
  ctx: FredAuthCtx,
  input: { address: string; leaseUuid: string },
  opts: LifecycleCallOptions = {},
): Promise<{
  lease_uuid: string;
  idempotency_key: string;
  status: string;
  ready?: FredLeaseStatus;
}> {
  const { address, leaseUuid } = input;
  // Resolve ONCE: a second call would mint a second timeout from the same `timeout`.
  const signal = resolveFredSignal(opts);
  signal?.throwIfAborted();
  const idempotencyKey = resolveMaintenanceIdempotencyKey(opts.idempotencyKey);

  // Fast path: a supplied providerUrl skips both on-chain queries (fetchActiveLease + resolveProviderUrl).
  let providerUrl: string;
  if (opts.providerUrl) {
    providerUrl = opts.providerUrl;
  } else {
    const lease = await fetchActiveLease(ctx, leaseUuid, 'cannot be restarted');
    providerUrl = await resolveProviderUrl(ctx, lease.providerUuid);
  }

  // URL rejection is local and proves no maintenance request was sent.
  validateProviderUrl(providerUrl, { allowLoopback: ctx.allowLoopback });

  const authToken = await ctx.providerAuth.providerToken({
    address,
    leaseUuid,
  });
  // Final check immediately before the mutate POST: an abort during the
  // (slow-path) providerUrl resolution / token mint must not still fire the restart.
  signal?.throwIfAborted();
  const command = { operation: 'restart' as const, leaseUuid, idempotencyKey };
  let result: Awaited<ReturnType<typeof restartLease>>;
  try {
    result = await restartLease(
      providerUrl,
      leaseUuid,
      authToken,
      ctx.fetch,
      ctx.allowLoopback,
      idempotencyKey,
    );
  } catch (err) {
    throw maintenanceError(err, { ...command, outcome: 'unknown' });
  }
  const base = {
    lease_uuid: leaseUuid,
    idempotency_key: idempotencyKey,
    status: result.status,
  };

  if (opts.pollOptions === false) return base;
  try {
    const ready = await pollLeaseUntilReady(
      providerUrl,
      leaseUuid,
      () => ctx.providerAuth.providerToken({ address, leaseUuid }),
      { ...opts.pollOptions, abortSignal: signal },
      ctx.fetch,
      ctx.allowLoopback,
    );
    return { ...base, ready };
  } catch (err) {
    throw maintenanceWaitError(err, {
      ...command,
      signal,
      callerSignals: [opts.signal, opts.abortSignal],
    });
  }
}
