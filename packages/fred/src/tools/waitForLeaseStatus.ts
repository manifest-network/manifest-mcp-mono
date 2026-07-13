import {
  type CapabilityCtx,
  type FredLeaseStatus,
  LeaseState,
  type LeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  abortableSleep,
  getLeaseStatus,
  PROVISION_FAILED,
  PROVISION_IN_PROGRESS,
} from '../http/fred.js';
import type { ProviderAuthPort } from '../http/provider-auth.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

/** The capability slice waitForLeaseStatus needs: query (provider lookup) + chain (rate limit +
 *  chainId + broadcast address) + fetch (provider HTTP) + providerAuth (mints the per-poll ADR-036
 *  status token). `logger` is an ACTIVE dependency (contains a throwing onStatus). `events` is a
 *  forward-compat slot for the eventual WS-fed wait source (unused by this poll-backed body). */
export type WaitForLeaseStatusCtx = Pick<
  CapabilityCtx,
  'query' | 'chain' | 'fetch' | 'logger' | 'events'
> & { providerAuth: ProviderAuthPort; readonly allowLoopback?: boolean };

export interface WaitForLeaseStatusOptions {
  /** Optional INTERMEDIATE-poll progress. Deduped on (state, provision_status) unless emitEvery.
   *  NOT fired for the terminal status — that arrives via the resolved promise (render `final` too). */
  onStatus?: (status: FredLeaseStatus) => void;
  /** Caller cancellation. Aborting REJECTS with signal.reason and cancels the in-flight poll. */
  signal?: AbortSignal;
  /** Poll DEADLINE in ms (default 120000). Reaching it on a non-terminal lease REJECTS. */
  timeout?: number;
  /** Poll interval in ms (default 3000). */
  intervalMs?: number;
  /** false (default) = dedup onStatus on (state, provision_status); true = raw per-poll. */
  emitEvery?: boolean;
}

/** Terminal classification, mirroring `pollLeaseUntilReady` in http/fred.ts but returning a verdict
 *  instead of resolve/throw. Reuses the EXPORTED PROVISION_* sets so it never drifts. */
type Terminal = 'success' | 'failure' | 'pending';
function classifyTerminal(s: FredLeaseStatus): Terminal {
  switch (s.state) {
    case LeaseState.LEASE_STATE_ACTIVE: {
      const ps = s.provision_status;
      if (ps !== undefined) {
        if (PROVISION_FAILED.has(ps)) return 'failure';
        if (PROVISION_IN_PROGRESS.has(ps)) return 'pending';
      }
      return 'success'; // ACTIVE + settled/absent/unrecognized provision_status (forward-compat, like pollLeaseUntilReady)
    }
    case LeaseState.LEASE_STATE_CLOSED:
    case LeaseState.LEASE_STATE_REJECTED:
    case LeaseState.LEASE_STATE_EXPIRED:
      return 'failure';
    default:
      return 'pending'; // PENDING / UNRECOGNIZED — keep watching until terminal or the deadline
  }
}

/** True iff `status` is a lease-FAILURE terminal. PRECONDITION: call only on a settled/terminal
 *  status (the resolved promise value) — returns false for a PENDING status, so do NOT infer success
 *  by negation on a non-terminal snapshot. */
export function isLeaseFailureTerminal(status: FredLeaseStatus): boolean {
  return classifyTerminal(status) === 'failure';
}

/**
 * Wait for a lease's Fred provision status to converge to a terminal state, polling the provider's
 * /v1/leases/{uuid}/status endpoint. RESOLVES with the final FredLeaseStatus at ANY terminal (success
 * OR observed failure — use isLeaseFailureTerminal). REJECTS on setup failure, poll deadline (timeout),
 * network/parse errors, and abort (signal → reject with signal.reason; the in-flight poll is cancelled).
 * onStatus (optional) reports INTERMEDIATE polls only, deduped unless emitEvery. Poll-backed in P0
 * (ctx.events WS transport deferred). (cosmjs signAndBroadcast + isDeliverTxFailure shape.)
 */
export async function waitForLeaseStatus(
  ctx: WaitForLeaseStatusCtx,
  leaseUuid: LeaseUuid,
  opts: WaitForLeaseStatusOptions = {},
): Promise<FredLeaseStatus> {
  const { signal, onStatus, emitEvery } = opts;
  const intervalMs = opts.intervalMs ?? 3_000;
  const timeoutMs = opts.timeout ?? 120_000;

  signal?.throwIfAborted(); // prompt pre-abort: no chain/provider work

  await ctx.chain.acquireRateLimit();
  const address = await ctx.chain.getAddress();
  const leaseRes = await ctx.query.liftedinit.billing.v1.lease({ leaseUuid });
  if (!leaseRes.lease) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }
  const providerUrl = await resolveProviderUrl(
    ctx,
    leaseRes.lease.providerUuid,
  );

  let lastKey: string | undefined;
  const emitIntermediate = (status: FredLeaseStatus): void => {
    if (!onStatus) return;
    const key = `${status.state}|${status.provision_status ?? ''}`;
    if (emitEvery || key !== lastKey) {
      lastKey = key;
      try {
        onStatus(status);
      } catch (cbErr) {
        ctx.logger.warn(
          `waitForLeaseStatus: onStatus callback threw and was contained: ${
            cbErr instanceof Error ? cbErr.message : String(cbErr)
          }`,
        );
      }
    }
  };

  const deadlineAt = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted(); // abort observed between polls
    let status: FredLeaseStatus;
    try {
      const token = await ctx.providerAuth.providerToken({
        address,
        leaseUuid,
      });
      status = await getLeaseStatus(
        providerUrl,
        leaseUuid,
        token,
        ctx.fetch,
        signal,
        ctx.allowLoopback,
      );
    } catch (err) {
      if (signal?.aborted) throw signal.reason; // abort-during-fetch: reject with the abort reason FIRST
      throw err; // network/parse → reject
    }
    if (classifyTerminal(status) !== 'pending') return status; // resolve (terminal NOT emitted via onStatus)
    emitIntermediate(status);
    if (Date.now() >= deadlineAt) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `waitForLeaseStatus timed out after ${timeoutMs}ms; lease ${leaseUuid} still non-terminal`,
      );
    }
    await abortableSleep(intervalMs, signal); // rejects with signal.reason on abort during the interval
  }
}
