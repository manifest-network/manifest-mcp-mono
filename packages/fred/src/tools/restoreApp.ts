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
import { resolveFredSignal } from './call-signal.js';
import { createLease } from './createLease.js';
import { fetchLease } from './fetchLease.js';
import type { LifecycleCallOptions } from './lifecycle-options.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

/**
 * Restore-POST statuses where the provider provably rejected BEFORE adopting
 * anything → safe to cancel the empty PENDING shell and hand the credit back.
 * Everything NOT listed here is in-doubt and must never be auto-cancelled.
 *
 * `429` earns its place the same way `401` does: Fred's `TenantRateLimiter`
 * rejects inside `AuthMiddleware`, so the restore handler never runs.
 *
 * Deliberately ABSENT, and the interesting case: **502**. Fred began authoring a
 * tenant-facing 502 in ENG-620/ENG-739 ("the provider backend returned an unusable
 * error; the request was not applied") where it previously relayed an off-contract
 * backend body as a 400 or 404. Fred's own 502 IS uncommitted — but a 502 is also
 * exactly what a reverse proxy in front of Fred mints, and there the POST may have
 * reached Fred and been adopted. Mono cannot tell the two apart from the wire, so it
 * takes the recoverable error: an orphaned PENDING lease (surfaced with the
 * `cancel-lease` remedy) rather than a `cancel-lease` fired at a restore that
 * committed, which would destroy the adopted data. `restoreApp.test.ts` pins both
 * halves of this asymmetry.
 */
const UNCOMMITTED_TERMINAL = new Set([400, 401, 404, 409, 422, 429, 503]);

/** Uncommitted statuses whose cause is transient — the agent may deliberately
 *  re-invoke once it clears. Everything else in the set is a stable rejection. */
const UNCOMMITTED_RETRYABLE = new Set([429, 503]);

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
  // in-doubt orphan. A mint FAILURE keeps its original routing.
  let newToken: string;
  try {
    newToken = await ctx.providerAuth.providerToken({
      address,
      leaseUuid: newLeaseUuid,
    });
  } catch (err) {
    return await handleRestoreFailure(ctx, err, {
      newLeaseUuid,
      sourceLeaseUuid,
      sourceProviderUuid: source.providerUuid,
    });
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
    // NOTE: no `if (signal?.aborted) throw err` bypass here. Every abort that can
    // still be acted on is handled above, before the POST; what reaches this catch is
    // a real POST failure that may merely COINCIDE with a cancel. Letting a coincident
    // cancel short-circuit would suppress both the compensation and the orphan record,
    // so side-effect classification depends on the provider's answer alone — never on
    // whether the caller also cancelled (ENG-666).
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
    // (A caller abort propagates; ENG-699 owns enriching that cancellation with
    // the committed lease context.)
    if (signal?.aborted) throw err;
    if (
      ProviderApiError.isProviderApiError(err) &&
      err.kind === 'poll_verdict'
    ) {
      throw err;
    }
    return { ...base, status: 'provisioning' };
  }
}

/**
 * Cancelled after the create-lease broadcast but before the restore POST. The fresh
 * lease is an empty PENDING shell — nothing adopted — which is the same state the
 * UNCOMMITTED_TERMINAL branch already rolls back, so compensate rather than abandon.
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
    // cosmosTx takes no signal, so the caller's abort cannot sabotage the rollback.
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
    const code = UNCOMMITTED_RETRYABLE.has(status)
      ? ManifestMCPErrorCode.RESTORE_RETRYABLE
      : ManifestMCPErrorCode.RESTORE_REJECTED;
    // A throttle is only actionable with the delay attached. The transport already
    // parses `Retry-After` into `retryAfterMs`, so dropping it here would discard the
    // one fact that tells the agent when re-invoking is worth attempting.
    const retryAfterMs = ProviderApiError.isProviderApiError(err)
      ? err.retryAfterMs
      : undefined;
    const waitHint =
      retryAfterMs !== undefined
        ? ` The provider asked us to wait ${Math.ceil(retryAfterMs / 1000)}s before retrying.`
        : '';
    throw new ManifestMCPError(
      code,
      `Restore rejected (HTTP ${status}); the created lease ${ids.newLeaseUuid} was rolled back (credit released).${waitHint} ${cause}`,
    );
  }
  // In-doubt — the POST may have committed, so do NOT cancel. Reached by 5xx other
  // than 503 (500, and the 502 Fred added in ENG-620 — see UNCOMMITTED_TERMINAL for
  // why that one is deliberately not compensated), by a status-0 transport fault
  // (network / timeout), and by any status Fred grows that this file has not
  // classified. Defaulting an UNKNOWN status to in-doubt is the point: a new Fred
  // status must cost an orphaned lease, never an erroneous cancel.
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
