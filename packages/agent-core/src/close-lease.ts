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
 *      driving a `leasesByTenant` -> `lease-state.decode` ->
 *      `isTerminal` check. Terminal states (CLOSED / REJECTED / EXPIRED
 *      / INSUFFICIENT_FUNDS) count as success; PENDING / ACTIVE map to
 *      the `pending_drift` branch; lease not visible in the tenant
 *      payload maps to the catch-all `unclassified` branch.
 *   5. On verify-failure, invoke the simple-form `onFailure({ reason })`
 *      then throw `ManifestMCPError(TX_FAILED)`. On success, emit
 *      `onComplete` with the typed `CloseLeaseResult`.
 */

import {
  ManifestMCPError,
  ManifestMCPErrorCode,
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
 * @throws `ManifestMCPError(INVALID_CONFIG)` for args validation or when
 *   `onConfirm` returns `'no'`.
 * @throws `ManifestMCPError(TX_FAILED)` when post-broadcast verification
 *   shows the lease is still non-terminal (after `onFailure` has been
 *   invoked so the caller can react).
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
        ManifestMCPErrorCode.INVALID_CONFIG,
        'User declined to proceed with close-lease.',
      );
    }
  }
  callbacks.onProgress?.({ kind: 'user_confirmed' });

  await stopApp(opts.clientManager, args.leaseUuid);

  // Direct single-lease query (Copilot review PR #60, comment 3275999624):
  // the previous `leasesByTenant` + page-1-only pagination would
  // false-`not_found` for tenants with >100 leases. `billing.v1.lease`
  // is the same query shape `troubleshoot.ts` already uses; it's
  // tenant-agnostic and bounded to a single lease.
  const spec: VerificationSpec<unknown, CloseOutcome, CloseDiag> = {
    verifier: async () => {
      const queryClient = await opts.clientManager.getQueryClient();
      const result = await queryClient.liftedinit.billing.v1.lease({
        leaseUuid: args.leaseUuid,
      });
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

  const finalState: LeaseStateName =
    verifyResult.diagnostic.stateName ?? 'LEASE_STATE_CLOSED';
  const result: CloseLeaseResult = {
    leaseUuid: args.leaseUuid,
    finalState,
  };
  callbacks.onComplete?.(result);
  return result;
}

// --- Helpers --------------------------------------------------------

function validateArgs(args: CloseLeaseArgs): void {
  if (typeof args.leaseUuid !== 'string' || !UUID_RE.test(args.leaseUuid)) {
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
