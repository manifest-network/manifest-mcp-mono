/**
 * Public entry point: produce a markdown-formatted diagnostic report
 * for a given lease.
 *
 * Chain-only (no provider HTTP calls — `TroubleshootOptions` has no
 * `walletProvider` for ADR-036 auth). Composes:
 *
 *   - `queryClient.liftedinit.billing.v1.lease({ leaseUuid })` for the
 *     authoritative chain-side lease record.
 *   - `lease-state.decode` + `isTerminal` to translate the integer
 *     state into a canonical `LEASE_STATE_*` name and a
 *     guidance-routing terminal/non-terminal classification.
 *   - `lease-items.normalizeItem` to surface each item's serviceName
 *     and customDomain regardless of snake/camelCase payload shape.
 *
 * The returned `markdown` is plain text with markdown formatting — host
 * surfaces can render it in chat directly or embed in a richer
 * diagnostic UI.
 *
 * **Scope:** chain-only. `TroubleshootOptions` carries no `walletProvider`,
 * so provider-side diagnostics (`appStatus` / `getLeaseProvision` /
 * `getAppLogs`) are out of scope for this function. If the report
 * surfaces a recovery-worthy state (e.g. terminal / drift), the caller
 * composes `closeLease()` separately — agent-core's simple-form
 * `onFailure({ reason })` does not carry recovery options, so the
 * orchestration of "report → decide → close" lives at the host surface.
 */

import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { normalizeItem } from './internals/lease-items.js';
import {
  decode as decodeLeaseState,
  isTerminal,
} from './internals/lease-state.js';
import type {
  LeaseStateName,
  TroubleshootArgs,
  TroubleshootCallbacks,
  TroubleshootOptions,
  TroubleshootReport,
} from './types.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Generate a diagnostic markdown report for `args.leaseUuid`.
 *
 * @throws `ManifestMCPError(INVALID_CONFIG)` for args validation.
 * @throws `ManifestMCPError(QUERY_FAILED)` when the chain query fails
 *   (after `onFailure` has been invoked so the caller can react).
 */
export async function troubleshootDeployment(
  args: TroubleshootArgs,
  callbacks: TroubleshootCallbacks,
  opts: TroubleshootOptions,
): Promise<TroubleshootReport> {
  validateArgs(args);

  let leasePayload: unknown;
  try {
    // Pull `getQueryClient()` INSIDE the try (Copilot review PR #60,
    // comment 3276719462). `getQueryClient()` can throw
    // `INVALID_CONFIG` (neither rpcUrl nor restUrl set) or
    // `RPC_CONNECTION_FAILED` (connect failure). Catching here routes
    // those init-time failures through the same `onFailure` +
    // QUERY_FAILED / structured-passthrough normalization the chain-
    // query failure mode already gets — three modes, one disambiguation.
    const queryClient = await opts.clientManager.getQueryClient();
    const result = await queryClient.liftedinit.billing.v1.lease({
      leaseUuid: args.leaseUuid,
    });
    leasePayload = result.lease;
  } catch (err) {
    // Preserve structured `ManifestMCPError`s from the chain client
    // (Copilot review PR #60, comment 3276172289). Wrapping every
    // failure as `QUERY_FAILED` erases upstream error codes — a real
    // `INVALID_CONFIG` from the chain layer should surface to callers
    // with that code, not be collapsed to a less-specific category.
    // Mirrors the disambiguation `manage-domain.ts:lookupDomain`
    // adopted in commit aaa5cc5. Note: chain-NotFound for
    // `billing.v1.lease({ leaseUuid })` returns `{ lease: null }`
    // (handled below), so errors landing here are genuinely transport
    // or structured failures.
    const reason = `Failed to query lease ${args.leaseUuid}: ${err instanceof Error ? err.message : String(err)}`;
    if (callbacks.onFailure) {
      await callbacks.onFailure({ reason });
    }
    if (err instanceof ManifestMCPError) {
      throw err;
    }
    throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, reason);
  }

  if (leasePayload === null || leasePayload === undefined) {
    const reason = `Lease ${args.leaseUuid} not found on chain.`;
    if (callbacks.onFailure) {
      await callbacks.onFailure({ reason });
    }
    throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, reason);
  }

  const markdown = renderReport(args.leaseUuid, leasePayload);
  const report: TroubleshootReport = { markdown };
  callbacks.onComplete?.(report);
  return report;
}

// --- Helpers --------------------------------------------------------

function validateArgs(args: TroubleshootArgs): void {
  if (typeof args.leaseUuid !== 'string' || !args.leaseUuid.match(UUID_RE)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `troubleshootDeployment: leaseUuid must be a UUID; got "${args.leaseUuid}".`,
    );
  }
}

interface LeaseShape {
  uuid?: unknown;
  state?: unknown;
  providerUuid?: unknown;
  provider_uuid?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  closedAt?: unknown;
  closed_at?: unknown;
  items?: unknown;
}

function renderReport(leaseUuid: string, lease: unknown): string {
  const l = (lease ?? {}) as LeaseShape;
  const rawState = l.state;
  const stateName = decodeLeaseState(
    typeof rawState === 'number' || typeof rawState === 'string'
      ? rawState
      : undefined,
  );
  const stateLabel = stateName ?? `UNKNOWN(${String(rawState)})`;
  const providerUuid =
    readString(l.providerUuid) || readString(l.provider_uuid) || '(unknown)';
  const createdAt = readTimestamp(l.createdAt) ?? readTimestamp(l.created_at);
  const closedAt = readTimestamp(l.closedAt) ?? readTimestamp(l.closed_at);

  const rawItems = Array.isArray(l.items) ? l.items : [];
  const items = rawItems.map(normalizeItem);

  const lines: string[] = [];
  lines.push(`# Lease diagnostic — ${leaseUuid}`);
  lines.push('');
  lines.push('## Chain state');
  lines.push('');
  lines.push(`- **State:** ${stateLabel}`);
  lines.push(`- **Provider:** ${providerUuid}`);
  if (createdAt) lines.push(`- **Created:** ${createdAt}`);
  if (closedAt) lines.push(`- **Closed:** ${closedAt}`);
  lines.push('');

  lines.push('## Items');
  lines.push('');
  if (items.length === 0) {
    lines.push('_No items found on this lease._');
  } else {
    for (const item of items) {
      const svc = item.serviceName.length > 0 ? item.serviceName : '(default)';
      const dom =
        item.customDomain.length > 0 ? item.customDomain : '(no custom domain)';
      lines.push(`- **${svc}** → ${dom}`);
    }
  }
  lines.push('');

  lines.push('## Guidance');
  lines.push('');
  for (const tip of guidanceFor(stateName)) {
    lines.push(`- ${tip}`);
  }

  return lines.join('\n');
}

function guidanceFor(state: LeaseStateName | undefined): string[] {
  if (state === undefined) {
    return [
      'Lease state could not be decoded. Re-query in a moment, or check the chain client logs for transport errors.',
    ];
  }
  if (isTerminal(state)) {
    return [
      `Lease is in terminal state \`${state}\`. No further provider activity expected.`,
      'To redeploy, create a new lease via `deployApp`.',
    ];
  }
  switch (state) {
    case 'LEASE_STATE_PENDING':
      return [
        'Lease is awaiting provider acknowledgement.',
        'If pending persists for more than a few minutes, the provider may be offline; consider closing and redeploying.',
      ];
    case 'LEASE_STATE_ACTIVE':
      return [
        'Lease is active on the provider. App-level status / logs require a provider HTTP call with an ADR-036 auth token (out of scope for this chain-only diagnostic).',
      ];
    default:
      return [
        `Lease state is \`${state}\`. Review the chain proto for the expected next transition.`,
      ];
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return value;
  return undefined;
}
