import { toHex } from '@cosmjs/encoding';
import {
  cosmosTx,
  logger,
  ManifestMCPError,
  ManifestMCPErrorCode,
  sanitizeForDisplay,
} from '@manifest-network/manifest-mcp-core';
import type { FredAuthCtx } from '../ctx.js';
import {
  type FredLeaseStatus,
  getLeaseProvision,
  pollLeaseUntilReady,
  restoreLease,
} from '../http/fred.js';
import { ProviderApiError } from '../http/provider.js';
import { createLease } from './createLease.js';
import { fetchLease } from './fetchLease.js';
import type { LifecycleCallOptions } from './lifecycle-options.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

/** Restore-POST failures where the provider rejected BEFORE adopting anything
 *  (uncommitted) → safe to cancel the empty PENDING shell. Everything else
 *  (500 / status-0 timeout / network) is in-doubt → never auto-cancel. */
const UNCOMMITTED_TERMINAL = new Set([400, 401, 404, 409, 422, 503]);

export interface RestoreResult {
  lease_uuid: string;
  source_lease_uuid: string;
  status: string;
  ready?: FredLeaseStatus;
  custom_domain_not_restored?: string[];
}

/**
 * Restore a closed lease's retained volumes onto a fresh lease (ENG-599). A saga:
 * pre-flight retained-check → create fresh PENDING lease from the source's on-chain
 * metaHash+items → restore POST (pivot) → cancel-lease on uncommitted-terminal
 * failure / orphan surface on in-doubt. See the design spec for the full model.
 */
export async function restoreApp(
  ctx: FredAuthCtx,
  input: { address: string; sourceLeaseUuid: string },
  opts: LifecycleCallOptions = {},
): Promise<RestoreResult> {
  const { address, sourceLeaseUuid } = input;
  opts.abortSignal?.throwIfAborted();

  // Rate-limit the whole op once up front (mirrors deployManifest): the pre-tx
  // reads below — fetchLease, resolveProviderUrl, getLeaseProvision — must not
  // bypass the limiter. createLease's cosmosTx acquires again for the tx leg.
  await ctx.chain.acquireRateLimit();

  // 1. Source lease on-chain (any state; must exist) + provider URL (same-backend).
  const source = await fetchLease(ctx, sourceLeaseUuid);
  const providerUrl =
    opts.providerUrl ?? (await resolveProviderUrl(ctx, source.providerUuid));

  // 2. Pre-flight: fail-fast (zero side effects) if the source isn't retained.
  //    Source-scoped token; its acceptance also proves source ownership.
  const sourceToken = await ctx.providerAuth.providerToken({
    address,
    leaseUuid: sourceLeaseUuid,
  });
  const provision = await getLeaseProvision(
    providerUrl,
    sourceLeaseUuid,
    sourceToken,
    ctx.fetch,
    ctx.allowLoopback,
  );
  if (provision.status !== 'retained') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.RESTORE_NOT_RETAINED,
      `Lease "${sourceLeaseUuid}" has no restorable retained data (status: ${provision.status}); the retention grace window may have expired.`,
    );
  }

  // 3. Reconstruct + create the fresh PENDING lease from the source's record.
  const metaHashHex = toHex(source.metaHash);
  const leaseItems = source.items.map((i) =>
    i.serviceName
      ? `${i.skuUuid}:${i.quantity}:${i.serviceName}`
      : `${i.skuUuid}:${i.quantity}`,
  );
  const customDomains = source.items
    .map((i) => i.customDomain)
    .filter((d): d is string => !!d);
  const newLeaseUuid = await createLease(ctx, { metaHashHex, leaseItems });

  // 4. Pivot: restore POST. ONLY the POST is inside the try — a post-202 poll
  //    timeout must NOT be misread as the in-doubt restore-POST timeout.
  let restoreStatus: string;
  try {
    opts.abortSignal?.throwIfAborted();
    const newToken = await ctx.providerAuth.providerToken({
      address,
      leaseUuid: newLeaseUuid,
    });
    const result = await restoreLease(
      providerUrl,
      newLeaseUuid,
      sourceLeaseUuid,
      newToken,
      ctx.fetch,
      ctx.allowLoopback,
    );
    restoreStatus = result.status;
  } catch (err) {
    // A ProviderApiError with a 2xx status means the restore COMMITTED but the
    // (202) body was empty/non-JSON and parseJsonResponse threw. Treat it as
    // committed — routing it to failure handling would advise cancelling a
    // lease with adopted volumes (data loss). Only non-2xx is a real failure.
    if (
      ProviderApiError.isProviderApiError(err) &&
      err.status >= 200 &&
      err.status < 300
    ) {
      restoreStatus = 'provisioning';
    } else {
      return await handleRestoreFailure(ctx, err, {
        newLeaseUuid,
        sourceLeaseUuid,
        sourceProviderUuid: source.providerUuid,
      });
    }
  }

  // Committed (202). Post-pivot: never compensate from here on.
  const base: RestoreResult = {
    lease_uuid: newLeaseUuid,
    source_lease_uuid: sourceLeaseUuid,
    status: restoreStatus,
    ...(customDomains.length
      ? { custom_domain_not_restored: customDomains }
      : {}),
  };
  if (opts.pollOptions === false) return base;
  try {
    const ready = await pollLeaseUntilReady(
      providerUrl,
      newLeaseUuid,
      () =>
        ctx.providerAuth.providerToken({ address, leaseUuid: newLeaseUuid }),
      { ...opts.pollOptions, abortSignal: opts.abortSignal },
      ctx.fetch,
      ctx.allowLoopback,
    );
    return { ...base, ready };
  } catch (err) {
    // Post-pivot poll timeout / terminal provisioning failure: the restore is
    // committed → report status, NEVER compensate. (A caller abort propagates.)
    if (opts.abortSignal?.aborted) throw err;
    return { ...base, status: 'provisioning' };
  }
}

async function handleRestoreFailure(
  ctx: FredAuthCtx,
  err: unknown,
  ids: {
    newLeaseUuid: string;
    sourceLeaseUuid: string;
    sourceProviderUuid: string;
  },
): Promise<never> {
  const status = ProviderApiError.isProviderApiError(err)
    ? err.status
    : undefined;
  // The cause can be a ProviderApiError whose message is provider-controlled
  // response-body text (untrusted on-chain SKU origin). Sanitize before it is
  // interpolated into a model/human-facing error message (ENG-555).
  const cause = sanitizeForDisplay(
    err instanceof Error ? err.message : String(err),
    256,
  ) as string;

  if (status !== undefined && UNCOMMITTED_TERMINAL.has(status)) {
    // Uncommitted → nothing adopted → cancel the empty PENDING shell (single
    // best-effort; the orphan surface below is the safety net if it fails).
    try {
      await cosmosTx(
        ctx.chain,
        'billing',
        'cancel-lease',
        [ids.newLeaseUuid],
        true,
      );
    } catch (cancelErr) {
      const cx =
        cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
      return orphan(
        ids,
        'compensating-cancel',
        `${cause}; cancel failed: ${cx}`,
      );
    }
    const code =
      status === 503
        ? ManifestMCPErrorCode.RESTORE_RETRYABLE
        : ManifestMCPErrorCode.RESTORE_REJECTED;
    throw new ManifestMCPError(
      code,
      `Restore rejected (HTTP ${status}); the created lease ${ids.newLeaseUuid} was rolled back (credit released). ${cause}`,
    );
  }
  // In-doubt (500 / status-0 timeout / network) — may have committed → do NOT cancel.
  return orphan(ids, 'in-doubt', cause);
}

function orphan(
  ids: {
    newLeaseUuid: string;
    sourceLeaseUuid: string;
    sourceProviderUuid: string;
  },
  step: string,
  cause: string,
): never {
  // One greppable/alertable structured stderr line for every orphan outcome.
  logger.error(
    JSON.stringify({
      event: 'restore_orphan',
      outcome: 'manual-intervention-required',
      step,
      newLeaseUuid: ids.newLeaseUuid,
      fromLeaseUuid: ids.sourceLeaseUuid,
      sourceProviderUuid: ids.sourceProviderUuid,
    }),
  );
  throw new ManifestMCPError(
    ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
    `Restore left an orphaned PENDING lease ${ids.newLeaseUuid} (${step}). It reserves credit — cancel it with: cosmos_tx billing cancel-lease ${ids.newLeaseUuid} (via the chain server). Cause: ${cause}`,
    {
      orphaned_lease_uuid: ids.newLeaseUuid,
      source_lease_uuid: ids.sourceLeaseUuid,
      next_action: 'cosmos_tx billing cancel-lease',
    },
  );
}
