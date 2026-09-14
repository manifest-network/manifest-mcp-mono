import { isLeaseUuidShape } from './internals/uuid-shape.js';
/**
 * Public entry point: orchestrate tearing down an existing lease via the
 * polymorphic `stopApp` (close for ACTIVE, cancel for PENDING, no-op if
 * already terminal).
 *
 * Composition (mirrors `deploy-app.ts` / `manage-domain.ts`):
 *
 *   1. Validate args.
 *   2. Render a confirmation block + optionally consult `onConfirm`.
 *   3. Broadcast `stopApp` (submits `MsgCloseLease` for an ACTIVE lease,
 *      `MsgCancelLease` for a PENDING one; no-op if the lease is already
 *      terminal).
 *   4. Verify the post-broadcast on-chain state via `verifyAndRecover`
 *      driving a direct `billing.v1.lease({ leaseUuid })` query +
 *      `lease-state.decode` + `isTerminal`. Terminal states (CLOSED /
 *      REJECTED / EXPIRED / INSUFFICIENT_FUNDS) count as success;
 *      PENDING / ACTIVE map to the `pending_drift` branch; a chain
 *      response with no lease (`{ lease: null }`) maps to the catch-all
 *      `unclassified` branch.
 *   5. On a non-terminal or missing-lease verification result, invoke
 *      `onFailure({ reason })` then throw `ManifestMCPError(TX_FAILED)`.
 *      On success, emit
 *      `onComplete` with the typed `CloseLeaseResult`. If `stopApp` reconciled
 *      a failed blocking attempt, the result preserves its frozen snapshot.
 *      Terminal lease state does not establish whether that attempt was sent
 *      or included; those facts remain explicit snapshot fields.
 */

import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
  parseLeaseUuid,
  stopApp,
} from '@manifest-network/manifest-mcp-core';
import { makeCancellationScope } from './internals/cancellation.js';
import {
  decode as decodeLeaseState,
  isTerminal,
} from './internals/lease-state.js';
import {
  emitCompletion,
  emitProgress,
  notifyFailure,
} from './internals/safe-progress.js';
import {
  verificationErrorMessage,
  verificationQueryError,
  withVerificationOutcome,
} from './internals/verification-outcome.js';
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
 * @throws `ManifestMCPError` from the `stopApp()` teardown step, including
 *   query, validation, cancellation and transaction failures. A terminal
 *   pre-query resolves as a no-op; ACTIVE and PENDING leases select close
 *   and cancel respectively, and either operation can fail. After a
 *   non-cancellation failure from a blocking close/cancel attempt, a terminal
 *   re-query makes `stopApp` resolve `already_inactive` without a transaction
 *   receipt, and verification continues. Otherwise it preserves the original
 *   failure, except that a `PENDING→ACTIVE` cancel race becomes a new `TX_FAILED`
 *   with the known lease ID and the earlier attempt in `details.reconciliation`.
 *   `closeLease` propagates whichever rejection `stopApp` produces unchanged,
 *   without invoking `onFailure`. Catch the rejected promise to handle
 *   teardown failures; `onFailure` belongs to subsequent verification.
 * @throws `ManifestMCPError(TX_FAILED)` when post-broadcast verification
 *   reaches one of two failure modes (both with `onFailure({ reason })`
 *   invoked first):
 *     - the lease is still non-terminal (`pending_drift` branch — state
 *       decoded as PENDING / ACTIVE / similar non-terminal); or
 *     - the chain returns `{ lease: null }` post-close, so the lease is
 *       not visible on-chain (`unclassified` branch).
 *   Also covers a verifier success result missing its required state;
 *   that invariant failure does not invoke `onFailure`.
 * @throws `ManifestMCPError(QUERY_FAILED)` when verification client
 *   acquisition or the `billing.v1.lease` query raises a non-SDK error.
 *   These query failures invoke `onFailure({ reason })` before throwing.
 *   Unexpected non-SDK errors elsewhere in post-mutation verification
 *   (such as decoding or verifier spec/result validation) also become
 *   `QUERY_FAILED`, but bypass that query-failure callback. The outer
 *   receipt wrapper does not add an `onFailure` invocation.
 *   Post-mutation SDK errors preserve readable code/message values and their
 *   original cause; failed reads use `QUERY_FAILED` / fallback message text.
 *   The fresh error carries the stop outcome. An actual
 *   transaction receipt adds its hash, confirmation and `details.sent: true`;
 *   `already_inactive` adds no inferred submission evidence. When it retains
 *   a failed attempt's reconciliation snapshot, that snapshot is exposed under
 *   `details.reconciliation`; its explicit `sent: true` also sets the outer
 *   retry veto. The later verification error remains the cause. Reconcile a
 *   submitted transaction before considering another mutation.
 */
export async function closeLease(
  args: CloseLeaseArgs,
  callbacks: CloseLeaseCallbacks,
  opts: CloseLeaseOptions,
): Promise<CloseLeaseResult> {
  validateArgs(args);

  const cx = makeCancellationScope({
    opts,
    onProgress: callbacks.onProgress,
    opLabel: 'Lease close',
    broadcasts: true,
  });
  cx.throwIfCancelled();

  const block = renderConfirmationBlock(args);
  if (callbacks.onConfirm) {
    const yesNo = await cx.race(callbacks.onConfirm(block));
    if (yesNo !== 'yes') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
        'User declined to proceed with close-lease.',
      );
    }
  }
  emitProgress(callbacks.onProgress, { kind: 'user_confirmed' });

  cx.throwIfCancelled();

  // txCtx has no signer (ManageDomain/CloseLease flows carry no walletProvider);
  // the sender resolves from ctx.chain (the CosmosClientManager wallet). See OI-SENDER.
  const mutationReceipt = await stopApp(
    { chain: opts.clientManager, logger: noopLogger },
    { leaseUuid: parseLeaseUuid(args.leaseUuid) },
  );

  return withVerificationOutcome(mutationReceipt, async () => {
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
          const reason = `Failed to query lease ${args.leaseUuid} during close-verify: ${verificationErrorMessage(err)}`;
          await notifyFailure(callbacks.onFailure, { reason });
          if (err instanceof ManifestMCPError) {
            throw err;
          }
          throw verificationQueryError(reason, err);
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
      await notifyFailure(callbacks.onFailure, { reason });
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
    // Verification success must preserve the separate failed-attempt history,
    // including when its submission or inclusion status remains unknown.
    const reconciliation =
      mutationReceipt.outcome === 'already_inactive'
        ? mutationReceipt.reconciliation
        : undefined;
    const result: CloseLeaseResult = {
      leaseUuid: args.leaseUuid,
      finalState,
      ...(reconciliation === undefined ? {} : { reconciliation }),
    };
    emitCompletion(() => callbacks.onComplete?.(result));
    return result;
  });
}

// --- Helpers --------------------------------------------------------

function validateArgs(args: CloseLeaseArgs): void {
  if (!isLeaseUuidShape(args.leaseUuid)) {
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
