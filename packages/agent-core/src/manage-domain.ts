/**
 * Public entry point: orchestrate setting, clearing, or looking up a
 * lease item's custom domain.
 *
 * Composition (mirrors `deploy-app.ts`'s shape):
 *
 *   - `set` / `clear` render a confirmation block, optionally call
 *     `onConfirm`, broadcast `setItemCustomDomain` against the agent's
 *     bound chain client, then verify the post-broadcast on-chain state
 *     via `verifyAndRecover` driving `verify-domain-state` over the
 *     tenant's `leasesByTenant` payload. Branches are inline closures
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

/**
 * Set / clear / look up a lease item's custom domain.
 *
 * @throws `ManifestMCPError(INVALID_CONFIG)` for args validation, an
 *   `onConfirm` returning `'no'`, or post-broadcast verification reaching
 *   a `not_found` / `mismatch` outcome (after `onFailure` has been
 *   invoked so the caller can react).
 */
export async function manageDomain(
  args: ManageDomainArgs,
  callbacks: ManageDomainCallbacks,
  opts: ManageDomainOptions,
): Promise<ManageDomainResult> {
  validateArgs(args);

  if (args.action === 'lookup') {
    return await lookupDomain(args.fqdn, opts);
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
  const tenantAddress = await opts.clientManager.getAddress();
  const spec: VerificationSpec<
    unknown,
    VerifyDomainOutcome,
    VerifyDomainResult
  > = {
    verifier: async () => {
      const queryClient = await opts.clientManager.getQueryClient();
      const result = await queryClient.liftedinit.billing.v1.leasesByTenant({
        tenant: tenantAddress,
        stateFilter: 0,
        pagination: {
          key: new Uint8Array(),
          offset: 0n,
          limit: 100n,
          countTotal: false,
          reverse: false,
        },
      });
      const decoded = verifyDomainState(result, {
        leaseUuid: args.leaseUuid,
        ...(serviceName ? { serviceName } : {}),
        expected: fqdn,
      });
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
  if (typeof args.leaseUuid !== 'string' || !UUID_RE.test(args.leaseUuid)) {
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
    if (/^https?:\/\//i.test(candidate)) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `manageDomain set: fqdn must be a bare hostname (no scheme); got "${args.fqdn}".`,
      );
    }
    if (!FQDN_RE.test(candidate)) {
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
  opts: ManageDomainOptions,
): Promise<ManageDomainResult> {
  const customDomain = fqdn.trim();
  const queryClient = await opts.clientManager.getQueryClient();
  try {
    const result = await queryClient.liftedinit.billing.v1.leaseByCustomDomain({
      customDomain,
    });
    const uuid = readLeaseUuid(result?.lease);
    return {
      action: 'lookup',
      fqdn: customDomain,
      lease: uuid ? { leaseUuid: uuid } : null,
    };
  } catch {
    // Chain emits NotFound when the FQDN is unclaimed; surface as a
    // null lookup result rather than re-throwing — callers distinguish
    // "no claim" from "query failed" via the typed `null`.
    return { action: 'lookup', fqdn: customDomain, lease: null };
  }
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
