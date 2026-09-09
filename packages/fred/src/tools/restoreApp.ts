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
import {
  capProviderText,
  PROVIDER_TEXT_EXCERPT_CHARS,
  ProviderApiError,
} from '../http/provider.js';
import { resolveFredSignal } from './call-signal.js';
import { createLease } from './createLease.js';
import { fetchLease } from './fetchLease.js';
import type { LifecycleCallOptions } from './lifecycle-options.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

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
 * metaHash+items → restore POST (pivot). Only a locally proven pre-POST failure
 * permits compensation. Every POST exception requires reconciliation: HTTP status
 * and error prose do not establish non-adoption, even for 4xx or malformed 2xx.
 */
export async function restoreApp(
  ctx: FredAuthCtx,
  input: { address: string; sourceLeaseUuid: string },
  opts: LifecycleCallOptions = {},
): Promise<RestoreResult> {
  const { address, sourceLeaseUuid } = input;
  // Resolve ONCE: a second call would mint a second timeout from the same `timeout`.
  const signal = resolveFredSignal(opts);
  signal?.throwIfAborted();

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
  // Final check immediately before the non-idempotent create-lease broadcast: an
  // abort during the (slow-path) reads above must not still reserve credit on a
  // fresh lease (ENG-488). Throwing here — before any tx — leaves zero side effects.
  signal?.throwIfAborted();
  const newLeaseUuid = await createLease(ctx, { metaHashHex, leaseItems });

  // From here the lease EXISTS and reserves credit, so a cancel is no longer free:
  // the caller stopping does not un-reserve it, and over MCP the host never even sees
  // the rejection (a cancelled request gets no response). The restore POST provably
  // has not fired yet, so nothing is adopted — roll the empty PENDING shell back
  // rather than propagate a bare AbortError that names no lease (ENG-666 / Q-7).
  // Deliberately OUTSIDE the try below, so its error is never re-classified as a
  // restore failure.
  if (signal?.aborted) {
    return await handleRestoreAbort(ctx, {
      newLeaseUuid,
      sourceLeaseUuid,
      sourceProviderUuid: source.providerUuid,
    });
  }

  // Mint the token OUTSIDE the try. It is an await, so a cancel can land inside it,
  // and it is not the POST — a failure here provably means nothing was sent. Keeping
  // it out lets the abort re-check below run before the POST without its own error
  // falling into the POST's catch, which would misfile a rollback-safe state as an
  // in-doubt outcome. A mint failure also proves that the POST was never sent.
  let newToken: string;
  try {
    newToken = await ctx.providerAuth.providerToken({
      address,
      leaseUuid: newLeaseUuid,
    });
  } catch (err) {
    return await handleRestoreFailure(
      ctx,
      err,
      {
        newLeaseUuid,
        sourceLeaseUuid,
        sourceProviderUuid: source.providerUuid,
      },
      'pre-restore-post',
    );
  }
  // Re-check: the mint above is the one await between the guard and the POST.
  if (signal?.aborted) {
    return await handleRestoreAbort(ctx, {
      newLeaseUuid,
      sourceLeaseUuid,
      sourceProviderUuid: source.providerUuid,
    });
  }

  // 4. Pivot: restore POST. ONLY the POST is inside the try — a post-202 poll
  //    timeout must NOT be misread as the in-doubt restore-POST timeout.
  let restoreStatus: string;
  try {
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
    // Keep the reconciliation record even if cancellation coincides with this
    // failure. No POST error establishes non-adoption: Fred can relay a 422 with
    // an unknown backend verdict, and gateways can replace any response. A 2xx
    // with an unreadable/invalid body does not establish commitment either.
    return await handleRestoreFailure(ctx, err, {
      newLeaseUuid,
      sourceLeaseUuid,
      sourceProviderUuid: source.providerUuid,
    });
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
      { ...opts.pollOptions, abortSignal: signal },
      ctx.fetch,
      ctx.allowLoopback,
    );
    return { ...base, ready };
  } catch (err) {
    // Post-pivot poll timeout: the restore is committed → report it as still
    // provisioning and NEVER compensate. A provider-authored failure verdict
    // is different: preserve that rejection and its detail instead of
    // laundering it into an indistinguishable "still coming up" result.
    if (signal?.aborted) {
      // A cancelled MCP request may receive no response. Keep the recovery handle
      // in stderr too, without logging the caller's potentially sensitive reason.
      logger.warn(
        JSON.stringify({
          event: 'restore_poll_cancelled',
          outcome: 'committed',
          newLeaseUuid,
          fromLeaseUuid: sourceLeaseUuid,
          sourceProviderUuid: source.providerUuid,
        }),
      );
      throw new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
        `Restore committed to lease ${newLeaseUuid}; waiting for readiness was cancelled. Check app_status or app_diagnostics for this lease before taking further action.`,
        {
          lease_uuid: newLeaseUuid,
          source_lease_uuid: sourceLeaseUuid,
          committed: true,
          restore_status: base.status,
          next_action: 'app_diagnostics',
          reason: err,
          ...(base.custom_domain_not_restored && {
            custom_domain_not_restored: base.custom_domain_not_restored,
          }),
        },
      );
    }
    if (
      ProviderApiError.isProviderApiError(err) &&
      err.kind === 'poll_verdict'
    ) {
      const committedError = err.withContext({
        lease_uuid: newLeaseUuid,
        source_lease_uuid: sourceLeaseUuid,
        committed: true,
        restore_status: base.status,
        ...(base.custom_domain_not_restored && {
          custom_domain_not_restored: base.custom_domain_not_restored,
        }),
      });
      // ProviderApiError context is available to direct library callers, but the
      // MCP boundary deliberately serializes structured details only from
      // ManifestMCPError. Re-wrap this first-party post-commit classification so
      // restore_app returns the adopted lease handle without regex-parsing prose.
      throw new ManifestMCPError(
        ManifestMCPErrorCode.RESTORE_COMMITTED_FAILURE,
        `Restore committed to lease ${newLeaseUuid}, but the provider reported a failure verdict: ${capProviderText(committedError.message, PROVIDER_TEXT_EXCERPT_CHARS)}`,
        { ...committedError.details },
      );
    }
    return { ...base, status: 'provisioning' };
  }
}

/**
 * Cancelled after the create-lease broadcast but before the restore POST. The fresh
 * lease is an empty PENDING shell: local execution proves this restore never sent
 * its POST, so compensate rather than abandon it.
 *
 * This matters because a cancelled MCP request receives no response at all: an error
 * carrying the lease uuid would never reach the host, so a compensating cancel and a
 * stderr line are the only channels that survive (ENG-666 / Q-7).
 */
async function handleRestoreAbort(
  ctx: FredAuthCtx,
  ids: {
    newLeaseUuid: string;
    sourceLeaseUuid: string;
    sourceProviderUuid: string;
  },
): Promise<never> {
  try {
    // Deliberately omit a signal: caller cancellation must not sabotage this safe rollback.
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
      'abort-compensating-cancel',
      `cancelled by caller; cancel failed: ${cx}`,
    );
  }
  // Same single-line JSON shape as orphan(), so both outcomes are greppable. warn,
  // not error: a rolled-back lease needs no manual intervention.
  logger.warn(
    JSON.stringify({
      event: 'restore_aborted',
      outcome: 'rolled-back',
      step: 'pre-restore-post',
      newLeaseUuid: ids.newLeaseUuid,
      fromLeaseUuid: ids.sourceLeaseUuid,
      sourceProviderUuid: ids.sourceProviderUuid,
    }),
  );
  throw new ManifestMCPError(
    ManifestMCPErrorCode.OPERATION_CANCELLED,
    `Restore cancelled after the lease was created; lease ${ids.newLeaseUuid} was rolled back (credit released). No data was adopted.`,
    {
      lease_uuid: ids.newLeaseUuid,
      source_lease_uuid: ids.sourceLeaseUuid,
      rolled_back: true,
    },
  );
}

async function handleRestoreFailure(
  ctx: FredAuthCtx,
  err: unknown,
  ids: {
    newLeaseUuid: string;
    sourceLeaseUuid: string;
    sourceProviderUuid: string;
  },
  phase: 'pre-restore-post' | 'restore-post' = 'restore-post',
): Promise<never> {
  // The cause can be a ProviderApiError whose message is provider-controlled
  // response-body text (untrusted on-chain SKU origin). Sanitize before it is
  // interpolated into a model/human-facing error message (ENG-555).
  const cause = sanitizeForDisplay(
    err instanceof Error ? err.message : String(err),
    256,
  ) as string;

  if (phase === 'pre-restore-post') {
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
    throw new ManifestMCPError(
      ManifestMCPErrorCode.RESTORE_REJECTED,
      `Restore failed before the POST; the created lease ${ids.newLeaseUuid} was rolled back (credit released). ${cause}`,
      {
        lease_uuid: ids.newLeaseUuid,
        source_lease_uuid: ids.sourceLeaseUuid,
        adoption_status: 'not_adopted',
        rolled_back: true,
      },
    );
  }
  // These fields are diagnostics, never evidence authorizing cancellation or
  // replay. In particular, Retry-After does not make a non-idempotent restore safe.
  return orphan(
    ids,
    'in-doubt',
    cause,
    ProviderApiError.isProviderApiError(err)
      ? {
          provider_status: err.status,
          ...(err.kind !== undefined && { provider_error_kind: err.kind }),
          ...(err.retryAfterMs !== undefined && {
            retry_after_ms: err.retryAfterMs,
          }),
        }
      : undefined,
  );
}

function orphan(
  ids: {
    newLeaseUuid: string;
    sourceLeaseUuid: string;
    sourceProviderUuid: string;
  },
  step: 'abort-compensating-cancel' | 'compensating-cancel' | 'in-doubt',
  cause: string,
  providerDetails?: {
    provider_status: number;
    provider_error_kind?: string;
    retry_after_ms?: number;
  },
): never {
  const adoptionStatus = step === 'in-doubt' ? 'unknown' : 'not_adopted';
  // One greppable/alertable structured stderr line for every unresolved outcome.
  logger.error(
    JSON.stringify({
      event: 'restore_orphan',
      outcome: 'manual-intervention-required',
      step,
      adoption_status: adoptionStatus,
      newLeaseUuid: ids.newLeaseUuid,
      fromLeaseUuid: ids.sourceLeaseUuid,
      sourceProviderUuid: ids.sourceProviderUuid,
    }),
  );
  throw new ManifestMCPError(
    ManifestMCPErrorCode.RESTORE_ORPHAN_COMPENSATION_FAILED,
    adoptionStatus === 'unknown'
      ? `Restore adoption outcome is unknown for lease ${ids.newLeaseUuid} from source ${ids.sourceLeaseUuid}. Check app_status and app_diagnostics for both leases and reconcile with the provider before retrying restore or considering cleanup. A PENDING chain state does not prove that no data was adopted. Cause: ${cause}`
      : `Restore did not adopt data, but cleanup of lease ${ids.newLeaseUuid} is unconfirmed (${step}). Check its chain state and, if it is still PENDING, cancel it with: cosmos_tx billing cancel-lease ${ids.newLeaseUuid} (via the chain server). Cause: ${cause}`,
    {
      lease_uuid: ids.newLeaseUuid,
      orphaned_lease_uuid: ids.newLeaseUuid,
      source_lease_uuid: ids.sourceLeaseUuid,
      source_provider_uuid: ids.sourceProviderUuid,
      adoption_status: adoptionStatus,
      ...providerDetails,
      next_action:
        adoptionStatus === 'unknown'
          ? 'app_diagnostics'
          : 'cosmos_tx billing cancel-lease',
    },
  );
}
