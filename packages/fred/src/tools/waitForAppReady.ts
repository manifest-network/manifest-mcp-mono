import { leaseStateToJSON } from '@manifest-network/manifest-mcp-core';
import type { FredAuthCtx } from '../ctx.js';
import { type FredLeaseStatus, pollLeaseUntilReady } from '../http/fred.js';
import { resolveFredSignal } from './call-signal.js';
import { fetchActiveLease } from './fetchActiveLease.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

export interface WaitForAppReadyOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly onProgress?: (status: FredLeaseStatus) => void;
  /**
   * Caller cancellation — the canonical spelling, shared with core's `CallOptions`.
   * There is deliberately no `timeout` here: `timeoutMs` above is already this call's
   * deadline, and two spellings for one concept would be ambiguous (ENG-666).
   */
  readonly signal?: AbortSignal;
  /** @deprecated Use `signal`. Both are honoured — either one cancels. */
  readonly abortSignal?: AbortSignal;
  /** Consecutive provider status-read failures to tolerate. See `PollOptions`. */
  readonly maxConsecutiveFailures?: number;
}

export interface WaitForAppReadyResult {
  readonly lease_uuid: string;
  readonly provider_uuid: string;
  readonly provider_url: string;
  readonly state: string;
  readonly status: FredLeaseStatus;
}

/**
 * Waits for a lease's provider-side state to reach ACTIVE, polling at
 * the configured interval. Throws ProviderApiError on terminal/timeout
 * the same way deployApp's internal poll does.
 *
 * Pre-flight: rejects if the lease isn't ACTIVE/PENDING on chain — there's
 * no point waiting on a closed/rejected/expired lease.
 */
export async function waitForAppReady(
  ctx: FredAuthCtx,
  input: { address: string; leaseUuid: string },
  opts: WaitForAppReadyOptions = {},
): Promise<WaitForAppReadyResult> {
  const { address, leaseUuid } = input;
  const lease = await fetchActiveLease(
    ctx,
    leaseUuid,
    'cannot wait for readiness',
  );
  const providerUrl = await resolveProviderUrl(ctx, lease.providerUuid);

  const status = await pollLeaseUntilReady(
    providerUrl,
    leaseUuid,
    () => ctx.providerAuth.providerToken({ address, leaseUuid }),
    {
      intervalMs: opts.intervalMs,
      timeoutMs: opts.timeoutMs,
      abortSignal: resolveFredSignal(opts),
      onProgress: opts.onProgress,
      maxConsecutiveFailures: opts.maxConsecutiveFailures,
    },
    ctx.fetch,
    ctx.allowLoopback,
  );

  return {
    lease_uuid: leaseUuid,
    provider_uuid: lease.providerUuid,
    provider_url: providerUrl,
    state: leaseStateToJSON(status.state),
    status,
  };
}
