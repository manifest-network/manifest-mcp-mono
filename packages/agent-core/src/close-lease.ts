/**
 * Public entry point: orchestrate closing an existing lease via the
 * `close-lease` billing tx.
 *
 * Composition (mirrors `deploy-app.ts` / `manage-domain.ts`):
 *
 *   1. Validate args.
 *   2. Render a confirmation block + optionally consult `onConfirm`.
 *   3. Broadcast `stopApp` (which submits `MsgCloseLease`).
 *   4. Verify the post-broadcast on-chain state via `verifyAndRecover`
 *      driving a direct `billing.v1.lease({ leaseUuid })` query +
 *      `lease-state.decode` + `isTerminal`. Terminal states (CLOSED /
 *      REJECTED / EXPIRED / INSUFFICIENT_FUNDS) count as success;
 *      PENDING / ACTIVE map to the `pending_drift` branch; a chain
 *      response with no lease (`{ lease: null }`) maps to the catch-all
 *      `unclassified` branch.
 *   5. On verify-failure, invoke the simple-form `onFailure({ reason })`
 *      then throw `ManifestMCPError(TX_FAILED)`. On success, emit
 *      `onComplete` with the typed `CloseLeaseResult`.
 */

import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
  parseLeaseUuid,
  stopApp,
} from '@manifest-network/manifest-mcp-core';
import {
  decode as decodeLeaseState,
  isTerminal,
} from './internals/lease-state.js';
import {
  type VerificationSpec,
  verifyAndRecover,
} from './internals/verify-recover.js';
import type {
  CloseLeaseArgs,
  CloseLeaseCallbacks,
  CloseLeaseOptions,
  CloseLeaseResult,
  DeploymentPlanBlock,
  LeaseStateName,
} from './types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CloseOutcome = 'terminal' | 'pending' | 'not_found';

interface CloseDiag {
  stateName?: LeaseStateName;
  reason?: string;
}

/**
 * Close a lease and verify it reached a terminal on-chain state.
 *
 * @throws `ManifestMCPError(INVALID_CONFIG)` for args validation.
 * @throws `ManifestMCPError(OPERATION_CANCELLED)` when `onConfirm` returns
 *   `'no'` (deliberate user cancellation — ENG-272).
 * @throws `ManifestMCPError` (typically `TX_FAILED`) propagated as-is
 *   from the `stopApp()` broadcast step. Broadcast errors do NOT invoke
 *   `onFailure` — that callback is reserved for post-broadcast
 *   verification failures. `stopApp` already raises a structured
 *   `ManifestMCPError` from the core package; wrapping it again at this
 *   layer would be redundant. Callers wanting to react to broadcast
 *   errors should catch them at the call site.
 * @throws `ManifestMCPError(TX_FAILED)` when post-broadcast verification
 *   reaches one of two failure modes (both with `onFailure({ reason })`
 *   invoked first):
 *     - the lease is still non-terminal (`pending_drift` branch — state
 *       decoded as PENDING / ACTIVE / similar non-terminal); or
 *     - the chain returns `{ lease: null }` post-close, so the lease is
 *       not visible on-chain (`unclassified` branch).
 * @throws `ManifestMCPError(QUERY_FAILED)` when the post-broadcast verify
 *   chain query (`billing.v1.lease`) raises a non-NotFound error
 *   (RPC / transport / decoding failure). Wrapped inside the verifier
 *   closure so the failure flows through `onFailure({ reason })` before
 *   the throw. Structured `ManifestMCPError`s raised by the chain client
 *   are re-thrown as-is (with `onFailure` invoked first).
 */
export async function closeLease(
  args: CloseLeaseArgs,
  callbacks: CloseLeaseCallbacks,
  opts: CloseLeaseOptions,
): Promise<CloseLeaseResult> {
  validateArgs(args);

  const block = renderConfirmationBlock(args);
  if (callbacks.onConfirm) {
    const yesNo = await callbacks.onConfirm(block);
    if (yesNo !== 'yes') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
        'User declined to proceed with close-lease.',
      );
    }
  }
  callbacks.onProgress?.({ kind: 'user_confirmed' });

  // txCtx has no signer (ManageDomain/CloseLease flows carry no walletProvider);
  // the sender resolves from ctx.chain (the CosmosClientManager wallet). See OI-SENDER.
  await stopApp(
    { chain: opts.clientManager, logger: noopLogger },
    { leaseUuid: parseLeaseUuid(args.leaseUuid) },
  );

  // Direct single-lease query (Copilot review PR #60, comment 3275999624):
  // the previous `leasesByTenant` + page-1-only pagination would
  // false-`not_found` for tenants with >100 leases. `billing.v1.lease`
  // is the same query shape `troubleshoot.ts` already uses; it's
  // tenant-agnostic and bounded to a single lease.
  const spec: VerificationSpec<unknown, CloseOutcome, CloseDiag> = {
    verifier: async () => {
      // Wrap the chain call in try/catch (Copilot review PR #60,
      // comment 3276419264): if `billing.v1.lease` rejects (RPC down,
      // transport, structured `ManifestMCPError`), the error would
      // otherwise propagate OUT of `verifyAndRecover` and bypass the
      // post-verify `onFailure({ reason })` callback below. Mirror
      // the disambiguation pattern from `lookupDomain` (commit aaa5cc5)
      // and `troubleshootDeployment` (commit f1a4737): invoke
      // `onFailure` first, then re-throw `ManifestMCPError` as-is or
      // wrap plain errors as `QUERY_FAILED`.
      let result: unknown;
      try {
        const queryClient = await opts.clientManager.getQueryClient();
        result = await queryClient.liftedinit.billing.v1.lease({
          leaseUuid: args.leaseUuid,
        });
      } catch (err) {
        const reason = `Failed to query lease ${args.leaseUuid} during close-verify: ${
          err instanceof Error ? err.message : String(err)
        }`;
        if (callbacks.onFailure) {
          await callbacks.onFailure({ reason });
        }
        if (err instanceof ManifestMCPError) {
          throw err;
        }
        throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, reason);
      }
      const lease = (result as { lease?: unknown })?.lease;
      if (lease === null || lease === undefined) {
        return {
          outcome: 'not_found' as const,
          diagnostic: {
            reason: `lease ${args.leaseUuid} not visible on chain after close`,
          },
        };
      }
      const rawState = (lease as { state?: unknown }).state;
      const stateName = decodeLeaseState(
        typeof rawState === 'number' || typeof rawState === 'string'
          ? rawState
          : undefined,
      );
      if (stateName === undefined) {
        return {
          outcome: 'pending' as const,
          diagnostic: {
            reason: `lease ${args.leaseUuid} state could not be decoded (raw=${String(rawState)})`,
          },
        };
      }
      return {
        outcome: (isTerminal(stateName) ? 'terminal' : 'pending') as
          | 'terminal'
          | 'pending',
        diagnostic: { stateName },
      };
    },
    successValues: ['terminal'],
    branches: {
      pending: {
        branchId: 'pending_drift',
        journalActionTags: ['close-lease-verify-pending'],
        buildFailureEnvelope: (d) => ({
          outcome: 'failed',
          reason:
            d.reason ??
            `close_lease tx accepted but state is still ${d.stateName ?? 'unknown'}.`,
        }),
        buildRecoveryOptions: () => [],
      },
      not_found: {
        branchId: 'unclassified',
        journalActionTags: ['close-lease-verify-not-found'],
        buildFailureEnvelope: (d) => ({
          outcome: 'failed',
          reason:
            d.reason ??
            `Lease ${args.leaseUuid} not visible on chain after close.`,
        }),
        buildRecoveryOptions: () => [],
      },
    },
  };

  const verifyResult = await verifyAndRecover(spec, undefined);

  if (verifyResult.result !== 'success') {
    const reason =
      verifyResult.failure?.reason ?? 'close-lease verification failed.';
    if (callbacks.onFailure) {
      await callbacks.onFailure({ reason });
    }
    throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
  }

  // Invariant: when `verifyAndRecover` returns success, the matched
  // outcome was `'terminal'`, and the verifier's `terminal` branch
  // ALWAYS sets `diagnostic.stateName` (see the spec above). A missing
  // `stateName` on the success path means the verifier invariant is
  // broken — likely a future refactor regression. The previous
  // implementation fell back to `'LEASE_STATE_CLOSED'` silently, which
  // would lie to the caller (Copilot review PR #60, comment 3276719603).
  // Fail loudly with a typed error instead. `TX_FAILED` is the closest
  // available code in `ManifestMCPErrorCode` (no `INTERNAL_ERROR`
  // variant); the message names the invariant explicitly.
  if (!verifyResult.diagnostic.stateName) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `close-lease verifier invariant violated: success outcome reached without diagnostic.stateName for lease ${args.leaseUuid}`,
    );
  }
  const finalState: LeaseStateName = verifyResult.diagnostic.stateName;
  const result: CloseLeaseResult = {
    leaseUuid: args.leaseUuid,
    finalState,
  };
  callbacks.onComplete?.(result);
  return result;
}

// --- Helpers --------------------------------------------------------

function validateArgs(args: CloseLeaseArgs): void {
  if (typeof args.leaseUuid !== 'string' || !args.leaseUuid.match(UUID_RE)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `closeLease: leaseUuid must be a UUID; got "${args.leaseUuid}".`,
    );
  }
}

function renderConfirmationBlock(args: CloseLeaseArgs): DeploymentPlanBlock {
  // Image is not tracked in `CloseLeaseArgs` and `stopApp` doesn't return it;
  // surface the gap explicitly so reviewers/users see the missing context
  // rather than silently omitting an image field they'd expect.
  const text = [
    `Close lease ${args.leaseUuid}.`,
    '  Image: (image not recorded)',
    '  This is permanent — the lease cannot be reopened.',
    '',
    'Proceed?',
  ].join('\n');
  return { text };
}
