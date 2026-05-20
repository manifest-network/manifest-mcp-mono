/**
 * Public entry point: orchestrate setting, clearing, or looking up a
 * lease item's custom domain.
 *
 * Composition (mirrors `deploy-app.ts`'s shape):
 *
 *   - `set` / `clear` render a confirmation block, optionally call
 *     `onConfirm`, broadcast `setItemCustomDomain` against the agent's
 *     bound chain client, then verify the post-broadcast on-chain state
 *     via `verifyAndRecover` driving `verify-domain-state` over a direct
 *     `billing.v1.lease({ leaseUuid })` single-lease query (tenant-
 *     agnostic, no pagination edge cases). Branches are inline closures
 *     bound to the per-action context; recovery options are intentionally
 *     empty so the verifier surfaces failures via the simple-form
 *     `onFailure({ reason })` adapter rather than the rich-form
 *     `RecoveryOption[]` prompt (manage-domain has no recovery primitives
 *     the orchestrator can dispatch; the user re-runs after a real fix).
 *
 *   - `lookup` skips broadcast/verify and resolves the FQDN via the
 *     `lease_by_custom_domain` chain query; returns `null` lease when
 *     the FQDN isn't claimed.
 */

import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  setItemCustomDomain,
} from '@manifest-network/manifest-mcp-core';
import {
  type VerifyDomainOutcome,
  type VerifyDomainResult,
  verifyDomainState,
} from './internals/verify-domain-state.js';
import {
  type VerificationSpec,
  verifyAndRecover,
} from './internals/verify-recover.js';
import type {
  DeploymentPlanBlock,
  ManageDomainArgs,
  ManageDomainCallbacks,
  ManageDomainOptions,
  ManageDomainResult,
} from './types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RFC 1123 hostname: each label 1-63 chars, alphanumeric + hyphens, no leading/
// trailing hyphen; total ≤253 chars; ≥2 labels (FQDN, not single-label host).
// Rejects scheme prefixes ('http://'), whitespace, trailing dots, IDN.
//
// Client-side typo gate only. The chain's `MsgSetItemCustomDomain` keeper is
// the authoritative validator (canonical lowercase, reserved-suffix rules,
// FQDN format). This anchored regex catches the obvious-malformed-input
// cases pre-broadcast so we don't waste a tx on `""`, `"  "`, `"http://x.y"`,
// or `"not a domain"`. Anything that passes here still goes through the
// chain's own validation.
const FQDN_RE =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

const SCHEME_PREFIX_RE = /^https?:\/\//i;

/**
 * Cosmos SDK / gRPC NotFound message patterns. Match against
 * `Error.message` to distinguish chain-keeper NotFound (treated as
 * "unclaimed FQDN" → typed `null` result) from real failures (treated
 * as `QUERY_FAILED` throws). Anchored loose patterns to tolerate
 * different keeper / transport formatting ("not found", "NotFound",
 * "no such record", "does not exist").
 *
 * Per CLAUDE.md: use `String.prototype.match()` over `RegExp.test()`
 * to avoid the CI security hook's false-positive on shell-execution
 * tokens.
 */
const NOT_FOUND_RES: readonly RegExp[] = [
  /not.?found/i,
  /no.?such/i,
  /does.?not.?exist/i,
];

/**
 * Set / clear / look up a lease item's custom domain.
 *
 * @throws `ManifestMCPError(INVALID_CONFIG)` for args validation or when
 *   `onConfirm` returns `'no'`.
 * @throws `ManifestMCPError(TX_FAILED)` when post-broadcast verification
 *   reaches a `not_found` / `mismatch` outcome (after `onFailure` has
 *   been invoked so the caller can react).
 * @throws `ManifestMCPError(QUERY_FAILED)` when the lookup chain query
 *   raises a non-NotFound error (RPC / transport / decoding failure); the
 *   keeper's `NotFound` on an unclaimed FQDN is surfaced as a typed
 *   `{ lease: null }` result, not a throw. Structured `ManifestMCPError`s
 *   raised by the chain client are re-thrown as-is (with `onFailure`
 *   invoked first).
 */
export async function manageDomain(
  args: ManageDomainArgs,
  callbacks: ManageDomainCallbacks,
  opts: ManageDomainOptions,
): Promise<ManageDomainResult> {
  validateArgs(args);

  if (args.action === 'lookup') {
    return await lookupDomain(args.fqdn, callbacks, opts);
  }

  const serviceName = args.serviceName;
  const fqdn = args.action === 'set' ? args.fqdn : '';

  // --- Confirmation block ---------------------------------------------
  const block = renderConfirmationBlock(args);
  if (callbacks.onConfirm) {
    const yesNo = await callbacks.onConfirm(block);
    if (yesNo !== 'yes') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `User declined to proceed with manage-domain ${args.action}.`,
      );
    }
  }
  callbacks.onProgress?.({ kind: 'user_confirmed' });

  // --- Broadcast ------------------------------------------------------
  const setOpts =
    args.action === 'set'
      ? serviceName
        ? { serviceName }
        : undefined
      : {
          clear: true as const,
          ...(serviceName ? { serviceName } : {}),
        };
  await setItemCustomDomain(opts.clientManager, args.leaseUuid, fqdn, setOpts);

  // --- Verify ---------------------------------------------------------
  // Direct single-lease query (Copilot review PR #60, comment 3275999569):
  // the previous `leasesByTenant` + page-1-only pagination would
  // false-`not_found` for tenants with >100 leases. `billing.v1.lease`
  // is the same query shape `troubleshoot.ts` already uses; it's
  // tenant-agnostic and bounded to a single lease.
  //
  // We wrap the single-lease result as `{ leases: [result.lease] }`
  // (or an empty array if the chain returns no match) so
  // `verifyDomainState` stays untouched — its `findLease` walks the
  // same shape, and a `not_found` outcome falls out naturally when the
  // wrapper array is empty.
  const spec: VerificationSpec<
    unknown,
    VerifyDomainOutcome,
    VerifyDomainResult
  > = {
    verifier: async () => {
      const queryClient = await opts.clientManager.getQueryClient();
      const result = await queryClient.liftedinit.billing.v1.lease({
        leaseUuid: args.leaseUuid,
      });
      const lease = (result as { lease?: unknown })?.lease;
      const leases = lease === null || lease === undefined ? [] : [lease];
      const decoded = verifyDomainState(
        { leases },
        {
          leaseUuid: args.leaseUuid,
          ...(serviceName ? { serviceName } : {}),
          expected: fqdn,
        },
      );
      return { outcome: decoded.outcome, diagnostic: decoded };
    },
    successValues: ['match'],
    branches: {
      mismatch: {
        branchId: 'domain_verification_mismatch',
        journalActionTags: ['domain-verification-mismatch'],
        buildFailureEnvelope: (d) => ({
          outcome: 'failed',
          reason:
            args.action === 'set'
              ? `Chain shows custom_domain="${d.actual ?? ''}" for lease ${args.leaseUuid}; expected "${fqdn}".`
              : `Chain still shows custom_domain="${d.actual ?? ''}" for lease ${args.leaseUuid}; expected cleared.`,
        }),
        buildRecoveryOptions: () => [],
      },
      not_found: {
        branchId: 'domain_not_found',
        journalActionTags: ['domain-verification-not-found'],
        buildFailureEnvelope: (d) => ({
          outcome: 'failed',
          reason:
            d.reason ??
            `Lease ${args.leaseUuid} not found when verifying domain state.`,
        }),
        buildRecoveryOptions: () => [],
      },
    },
  };

  const verifyResult = await verifyAndRecover(spec, undefined);
  const verified = verifyResult.result === 'success';
  const finalCustomDomain = deriveFinalCustomDomain(
    verifyResult.diagnostic,
    args.action,
  );

  if (!verified) {
    const reason =
      verifyResult.failure?.reason ??
      `manage-domain ${args.action} verification failed.`;
    if (callbacks.onFailure) {
      await callbacks.onFailure({ reason });
    }
    throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, reason);
  }

  const result: ManageDomainResult = {
    action: args.action,
    leaseUuid: args.leaseUuid,
    verified,
    finalCustomDomain,
  };
  callbacks.onComplete?.(result);
  return result;
}

// --- Helpers --------------------------------------------------------

function validateArgs(args: ManageDomainArgs): void {
  if (
    args.action !== 'set' &&
    args.action !== 'clear' &&
    args.action !== 'lookup'
  ) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `manageDomain: unknown action "${(args as { action?: string }).action}".`,
    );
  }
  if (args.action === 'lookup') {
    if (typeof args.fqdn !== 'string' || args.fqdn.trim() === '') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'manageDomain lookup: fqdn must be a non-empty string.',
      );
    }
    return;
  }
  if (typeof args.leaseUuid !== 'string' || !args.leaseUuid.match(UUID_RE)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `manageDomain ${args.action}: leaseUuid must be a UUID; got "${args.leaseUuid}".`,
    );
  }
  if (args.action === 'set') {
    if (typeof args.fqdn !== 'string' || args.fqdn.trim() === '') {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'manageDomain set: fqdn must be a non-empty string.',
      );
    }
    const candidate = args.fqdn.trim();
    if (candidate !== args.fqdn) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'manageDomain set: fqdn must not have surrounding whitespace.',
      );
    }
    if (candidate.match(SCHEME_PREFIX_RE)) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `manageDomain set: fqdn must be a bare hostname (no scheme); got "${args.fqdn}".`,
      );
    }
    if (!candidate.match(FQDN_RE)) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `manageDomain set: fqdn "${args.fqdn}" is not a valid RFC 1123 hostname (≤253 chars, ≥2 dot-separated labels of 1-63 alphanumeric/hyphen chars; no leading/trailing hyphens).`,
      );
    }
  }
}

function renderConfirmationBlock(
  args: Exclude<ManageDomainArgs, { action: 'lookup' }>,
): DeploymentPlanBlock {
  const lines: string[] = [];
  if (args.action === 'set') {
    lines.push(`Set custom domain on lease ${args.leaseUuid}:`);
    lines.push(`  FQDN:         ${args.fqdn}`);
    if (args.serviceName) {
      lines.push(`  Service:      ${args.serviceName}`);
    }
    lines.push('');
    lines.push('Proceed?');
  } else {
    lines.push(`Clear custom domain on lease ${args.leaseUuid}:`);
    if (args.serviceName) {
      lines.push(`  Service:      ${args.serviceName}`);
    }
    lines.push('');
    lines.push('Proceed?');
  }
  return { text: lines.join('\n') };
}

async function lookupDomain(
  fqdn: string,
  callbacks: ManageDomainCallbacks,
  opts: ManageDomainOptions,
): Promise<ManageDomainResult> {
  const customDomain = fqdn.trim();
  const queryClient = await opts.clientManager.getQueryClient();
  let result: unknown;
  try {
    result = await queryClient.liftedinit.billing.v1.leaseByCustomDomain({
      customDomain,
    });
  } catch (err) {
    // Narrowed disambiguation (Copilot review PR #60): the chain keeper
    // raises a NotFound-shaped error when the FQDN is unclaimed (cosmjs/
    // grpc surfaces this as a plain `Error` whose message matches
    // `/not.?found|no.?such|does.?not.?exist/i`). Only that case is
    // collapsed to the typed `{ lease: null }` result. Every other
    // failure mode (RPC transport, decoding, structured
    // `ManifestMCPError`, etc.) flows through `onFailure({ reason })`
    // then a typed throw — matching the lease-package's
    // `lease_by_custom_domain` handler (packages/lease/src/index.ts:442)
    // and `getBalance`'s `catchNotFound` pattern (packages/core/src/
    // tools/getBalance.ts:4). The bare `catch` was masking real failures.
    if (isNotFoundError(err)) {
      return { action: 'lookup', fqdn: customDomain, lease: null };
    }
    const reason = `lease_by_custom_domain lookup failed for "${customDomain}": ${
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
  const uuid = readLeaseUuid((result as { lease?: unknown })?.lease);
  return {
    action: 'lookup',
    fqdn: customDomain,
    lease: uuid ? { leaseUuid: uuid } : null,
  };
}

function isNotFoundError(err: unknown): boolean {
  // Pass-through guard for structured failures: a `ManifestMCPError` is
  // always a real, intentional error — never silently re-classified as
  // "FQDN unclaimed" even if its message happens to contain "not found".
  if (err instanceof ManifestMCPError) return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return NOT_FOUND_RES.some((re) => msg.match(re) !== null);
}

function readLeaseUuid(lease: unknown): string | undefined {
  if (lease === null || typeof lease !== 'object') return undefined;
  const r = lease as {
    uuid?: unknown;
    lease_uuid?: unknown;
    leaseUuid?: unknown;
  };
  const u = r.uuid ?? r.lease_uuid ?? r.leaseUuid;
  return typeof u === 'string' && u.length > 0 ? u : undefined;
}

function deriveFinalCustomDomain(
  diagnostic: VerifyDomainResult,
  action: 'set' | 'clear',
): string | null {
  if (action === 'clear') return null;
  const actual = diagnostic.actual ?? '';
  return actual.length > 0 ? actual : null;
}
