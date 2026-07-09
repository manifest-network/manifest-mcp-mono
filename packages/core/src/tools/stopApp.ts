import type { LeaseUuid } from '../brands.js';
import { cosmosTx } from '../cosmos.js';
import type { TxCtx } from '../ctx.js';
import { withTxConfirmation } from '../internals/tx-confirmation.js';
import { txExtrasFrom, txOverridesFrom } from '../internals/tx-opts.js';
// Routed through the manifest-types chokepoint (spec §8) rather than importing
// the manifestjs codegen path directly (dependency-cruiser manifestjs-types-chokepoint).
import { type Lease, LeaseState, leaseStateToJSON } from '../manifest-types.js';
import type { TxCallOptions } from '../options.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/**
 * Result of {@link stopApp}. Discriminated on `outcome` (the action taken):
 * `stopped` (ACTIVE lease closed), `cancelled` (PENDING lease cancelled), or
 * `already_inactive` (no broadcast — the lease was already terminal).
 * `outcome` — not `lease_state` — is the discriminant, because `stopped` and a
 * no-op `already_inactive` can both land on `LEASE_STATE_CLOSED`.
 */
export type StopAppResult =
  | {
      readonly lease_uuid: LeaseUuid;
      readonly outcome: 'stopped';
      readonly lease_state: 'LEASE_STATE_CLOSED';
      readonly transactionHash: string;
      readonly code: number;
    }
  | {
      readonly lease_uuid: LeaseUuid;
      readonly outcome: 'cancelled';
      readonly lease_state: 'LEASE_STATE_REJECTED';
      readonly transactionHash: string;
      readonly code: number;
    }
  | {
      readonly lease_uuid: LeaseUuid;
      readonly outcome: 'already_inactive';
      readonly lease_state: 'LEASE_STATE_REJECTED';
      readonly rejection_reason: string;
    }
  | {
      readonly lease_uuid: LeaseUuid;
      readonly outcome: 'already_inactive';
      readonly lease_state: 'LEASE_STATE_CLOSED' | 'LEASE_STATE_EXPIRED';
    };

const TERMINAL_STATES: ReadonlySet<LeaseState> = new Set([
  LeaseState.LEASE_STATE_CLOSED,
  LeaseState.LEASE_STATE_REJECTED,
  LeaseState.LEASE_STATE_EXPIRED,
]);

/** Build the `already_inactive` result from a lease observed in a terminal state. */
function inactive(leaseUuid: LeaseUuid, lease: Lease): StopAppResult {
  if (lease.state === LeaseState.LEASE_STATE_REJECTED) {
    return {
      lease_uuid: leaseUuid,
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      // Free-form, provider- or tenant-set. UNTRUSTED passthrough (do not interpret).
      // `?? ''` keeps the `string` contract honest: the RPC/LCD decode paths default
      // this to '' and a REJECTED lease always carries a reason on-chain, but guard
      // against a decode path that omits it (e.g. fromAmino) — mirrors the repo's
      // defensive `l.items ?? []` convention (reads.ts toBrandedLease).
      rejection_reason: lease.rejectionReason ?? '',
    };
  }
  return {
    lease_uuid: leaseUuid,
    outcome: 'already_inactive',
    lease_state:
      lease.state === LeaseState.LEASE_STATE_CLOSED
        ? 'LEASE_STATE_CLOSED'
        : 'LEASE_STATE_EXPIRED',
  };
}

/**
 * Tear down a lease, whatever state it is in. Pre-queries the authoritative
 * on-chain state and dispatches: ACTIVE -> close-lease, PENDING -> cancel-lease,
 * terminal -> no-op success. Idempotent; never string-matches a rawLog.
 * Assumes a TENANT signer (cancel-lease is tenant-only).
 */
export async function stopApp(
  ctx: TxCtx,
  input: { leaseUuid: LeaseUuid },
  opts?: TxCallOptions,
): Promise<StopAppResult> {
  const { leaseUuid } = input;

  // Query the lease. A raw thrown query (transport/decode) is wrapped as QUERY_FAILED;
  // an existing ManifestMCPError (e.g. RPC_CONNECTION_FAILED from getQueryClient) passes through unchanged.
  const queryLease = async (): Promise<Lease | null> => {
    try {
      const queryClient = await ctx.chain.getQueryClient();
      const { lease } = await queryClient.liftedinit.billing.v1.lease({
        leaseUuid,
      });
      return lease ?? null;
    } catch (err) {
      if (err instanceof ManifestMCPError) throw err;
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `Failed to query lease ${leaseUuid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const lease = await queryLease();
  if (lease === null) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }
  if (TERMINAL_STATES.has(lease.state)) {
    return inactive(leaseUuid, lease);
  }

  // NO requireAuthSigner: the wallet is on ctx.chain (not ctx.signer, unset here);
  // the query-only INVALID_CONFIG guard comes from cosmosTx -> ctx.chain.getSigningClient(). See OI-SENDER.
  const subcommand =
    lease.state === LeaseState.LEASE_STATE_ACTIVE
      ? ('close-lease' as const)
      : lease.state === LeaseState.LEASE_STATE_PENDING
        ? ('cancel-lease' as const)
        : null;
  if (subcommand === null) {
    // Query succeeded but returned an unrecognized/unspecified state (vs a query that THREW -> QUERY_FAILED).
    // TX_FAILED is the closest non-retryable code (no INTERNAL_ERROR variant; mirrors close-lease.ts).
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Lease "${leaseUuid}" is in an unrecognized state (${leaseStateToJSON(lease.state)}); refusing to guess.`,
    );
  }

  try {
    const result = await withTxConfirmation(
      () =>
        cosmosTx(
          ctx.chain,
          'billing',
          subcommand,
          [leaseUuid],
          true,
          txOverridesFrom(opts),
          txExtrasFrom(opts),
        ),
      opts,
    );
    return subcommand === 'close-lease'
      ? {
          lease_uuid: leaseUuid,
          outcome: 'stopped',
          lease_state: 'LEASE_STATE_CLOSED',
          transactionHash: result.transactionHash,
          code: result.code,
        }
      : {
          lease_uuid: leaseUuid,
          outcome: 'cancelled',
          lease_state: 'LEASE_STATE_REJECTED',
          transactionHash: result.transactionHash,
          code: result.code,
        };
  } catch (err) {
    // Preserve a deliberate cancellation (aborted withTxConfirmation) — never reclassify it.
    if (
      err instanceof ManifestMCPError &&
      err.code === ManifestMCPErrorCode.OPERATION_CANCELLED
    ) {
      throw err;
    }
    // TOCTOU: state may have flipped between pre-query and broadcast. Re-query ONCE.
    let fresh: Lease | null;
    try {
      fresh = await queryLease();
    } catch {
      throw err; // re-query failed -> surface the original broadcast error
    }
    if (fresh !== null && TERMINAL_STATES.has(fresh.state)) {
      return inactive(leaseUuid, fresh); // converged (incl. reason from THIS re-query)
    }
    // Only the PENDING->ACTIVE *cancel* race maps to the retry error. Gate on the op:
    // a plain ACTIVE->close broadcast failure ALSO leaves the lease ACTIVE, but that must
    // surface the ORIGINAL error, not a misleading "state changed" (design TOCTOU point 3).
    if (
      fresh !== null &&
      subcommand === 'cancel-lease' &&
      fresh.state === LeaseState.LEASE_STATE_ACTIVE
    ) {
      // A provider AcknowledgeLease raced our cancel. Refuse to auto-escalate cancel->close
      // (settlement differs). "re-invoke" here means the CALLER calls stopApp again (which
      // re-queries, sees ACTIVE, and dispatches to close) — NOT an automated retry: TX_FAILED
      // is intentionally non-retryable (retry.ts) so cosmosTx's inner withRetry can never
      // re-broadcast the submitted cancel-lease (double-spend guard).
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Lease "${leaseUuid}" state changed during teardown (now ACTIVE); re-invoke stopApp to close it.`,
      );
    }
    throw err; // unchanged actionable state (incl. a plain ACTIVE close failure) / null -> original
  }
}
