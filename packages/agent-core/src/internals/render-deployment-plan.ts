import { sanitizeForDisplay } from '@manifest-network/manifest-mcp-core';
import type { DeploymentPlanBlock, FeeEstimate, Plan } from '../types.js';
import {
  type DenomMap,
  EMPTY_DENOM_MAP,
  humanizeBalances,
  humanizeCoin,
} from './humanize-denom.js';

/**
 * Render the canonical `DeploymentPlan` block for `deployApp`'s
 * confirmation step. Consumes the typed `Plan` + `FeeEstimate {coins, gas}`
 * shape.
 *
 * **Why this is a renderer, not a builder:** the function consumes a
 * fully-resolved `Plan` (summary + readiness + fees) plus orchestrator-
 * supplied trim data (image / size / metaHash / customDomain). It
 * doesn't compose those inputs — `deployApp.ts` (commit B) constructs
 * the `Plan` from chain queries + estimates and threads it here.
 *
 * **Sync, pure-decision function** (per Q4 Bii pattern): no I/O, no
 * mutation, no implicit lookups. Caller pre-loads the `DenomMap` via
 * `await loadChainDenomMap(chainDataFile)` and passes it in. Default
 * fallback is the no-op `EMPTY_DENOM_MAP` — raw on-chain denoms render
 * verbatim. The `(empty)` literal continues to mark missing balances.
 *
 * **Fee humanization:** the new `FeeEstimate {coins: Coin[], gas}` shape
 * preserves multi-coin precision. The CJS read pre-humanized strings
 * (`--tx-fee "0.0023 MFX"`); the TS port humanizes `fees.coins[0]` at
 * render time using `humanizeCoin`, then concatenates with `(gas <n>)`.
 * Multi-coin fees: humanizes all coins with `humanizeBalances` (comma-
 * separated) and renders the result verbatim — gas suffix is appended
 * once.
 *
 * **`setDomain` fee sentinel:** when `plan.fees.setDomain` is the
 * `{notEstimated: true, reason}` sentinel (approach-3 no-representative-
 * lease fallback), the line emits the explicit "(not estimated — no
 * representative lease...)" message preserving the CJS's user-facing
 * "skipped" semantics.
 *
 * **`Provider:` line (ENG-258):** rendered immediately after `Size:` when a
 * pinned `providerUuid` is supplied (resolved by the SKU disambiguator so the
 * user sees which provider they are deploying to). Omitted when the field is
 * absent or empty (single-provider SKU — chain selects internally).
 */

/**
 * Same-denom single-coin: sum as `BigInt` (the underlying on-chain
 * unit), then humanize the total. Different denom OR multi-coin:
 * `"<a> + <b>"` concat (mirrors the CJS's `sumHumanFees` fallback).
 *
 * Copilot review fix (PR #58 r3250445951): the prior `sumHumanFees`
 * parsed humanized strings to float64, summed, and re-formatted —
 * breaking the BigInt invariant the rest of the denom-humanization
 * pipeline maintains (`humanize-denom.ts:_fmtScaledAmount` is
 * BigInt-based). Realistic create-lease + set-domain fees were tiny
 * so the hit rate was low; the inconsistency was real, and amounts
 * above `Number.MAX_SAFE_INTEGER` (2^53-1) would silently round.
 *
 * Operates on the underlying `FeeEstimate.coins` arrays directly so
 * BigInt precision is preserved through the sum. Humanization
 * happens once, at the end.
 */
function sumFees(a: FeeEstimate, b: FeeEstimate, denomMap: DenomMap): string {
  // Same-denom single-coin: BigInt sum, then humanize.
  if (a.coins.length === 1 && b.coins.length === 1) {
    const ca = a.coins[0];
    const cb = b.coins[0];
    if (ca && cb && ca.denom === cb.denom) {
      const sum = (BigInt(ca.amount) + BigInt(cb.amount)).toString();
      return humanizeCoin(sum, ca.denom, denomMap);
    }
  }
  // Different denom or multi-coin: fall back to concat, mirroring the
  // CJS's behavior. Humanize each side independently.
  return `${humanizeFeeAmount(a, denomMap)} + ${humanizeFeeAmount(b, denomMap)}`;
}

/**
 * Render a `FeeEstimate {coins, gas}` as the user-facing fee string.
 * Empty coins → `(empty)` literal (CJS parity). Single coin → humanized
 * `"<amount> <symbol>"`. Multi-coin → comma-joined.
 */
function humanizeFeeAmount(fee: FeeEstimate, denomMap: DenomMap): string {
  if (fee.coins.length === 0) return '(empty)';
  if (fee.coins.length === 1) {
    const c = fee.coins[0];
    if (c === undefined) return '(empty)';
    return humanizeCoin(c.amount, c.denom, denomMap);
  }
  return humanizeBalances(fee.coins, denomMap);
}

function formatFeeLine(humanFee: string, gas: number): string {
  return `${humanFee} (gas ${gas})`;
}

function formatSkuPrice(plan: Plan, denomMap: DenomMap): string {
  const sku = plan.readiness.sku;
  if (sku === null) return '(unknown — SKU has no listed price)';
  // SKU price amount + denom are provider-controlled on-chain strings, and
  // humanizeCoin renders an unknown denom (and a non-numeric amount) verbatim —
  // sanitize the composed value so it cannot forge a plan line (ENG-555).
  return `${sanitizeForDisplay(
    humanizeCoin(sku.price.amount, sku.price.denom, denomMap),
  )} / hour`;
}

function formatWallet(plan: Plan, denomMap: DenomMap): string {
  return humanizeBalances(plan.readiness.walletBalances, denomMap);
}

function formatCredits(plan: Plan, denomMap: DenomMap): string {
  const credits = plan.readiness.credits;
  if (credits === null) return 'none';
  const balances = credits.availableBalances;
  if (!Array.isArray(balances) || balances.length === 0) return '(empty)';
  return humanizeBalances(balances, denomMap);
}

export interface RenderDeploymentPlanInput {
  /** Frozen Plan (summary + readiness + fees). */
  plan: Plan;
  /** Pre-loaded denom map. Default: `EMPTY_DENOM_MAP` (raw on-chain rendering). */
  denomMap?: DenomMap;
  /** Primary image reference — first service's image for stacks. */
  image: string;
  /** SKU tier name (e.g. `docker-micro`, `small`). */
  size: string;
  /** Manifest meta-hash hex from `build_manifest_preview`. */
  metaHash: string;
  /** Optional custom-domain FQDN; presence drives the two-tx fee layout. */
  customDomain?: string;
  /** Optional stack-service holding the custom domain. */
  customDomainService?: string;
  /**
   * Pinned provider UUID resolved by the SKU disambiguator (ENG-258).
   * When non-empty, a `Provider:` line is rendered right after `Size:`
   * so the user sees which provider they are deploying to.
   */
  providerUuid?: string;
}

export function renderDeploymentPlan(
  input: RenderDeploymentPlanInput,
): DeploymentPlanBlock {
  const denomMap = input.denomMap ?? EMPTY_DENOM_MAP;
  const { summary } = input.plan;

  const manifestLine =
    `${summary.format ?? 'single'}, services=${summary.serviceCount}, ` +
    `ports=${summary.portCount}, env=${summary.envCount}`;

  const hasDomain =
    typeof input.customDomain === 'string' && input.customDomain.length > 0;

  // Create-lease fee — always present in PlanFees.
  const createFee = input.plan.fees.createLease;
  const createHuman = humanizeFeeAmount(createFee, denomMap);
  const createFeeLine = formatFeeLine(createHuman, createFee.gas);

  const hasProvider =
    typeof input.providerUuid === 'string' && input.providerUuid.length > 0;

  const lines: string[] = [
    'DeploymentPlan',
    `  Image:                     ${input.image}`,
    // SKU tier name is a provider-controlled on-chain string — sanitize so an
    // embedded newline/control char cannot forge a plan line (ENG-555).
    `  Size:                      ${sanitizeForDisplay(input.size, 64, '(unnamed SKU)')}`,
  ];

  if (hasProvider) {
    // providerUuid is a provider-controlled, unchecked trust-cast (NOT validated
    // to UUID grammar — real ids may be arbitrary short strings), so strip
    // control/format bytes rather than allowlist a grammar it may not follow.
    lines.push(
      `  Provider:                  ${sanitizeForDisplay(
        input.providerUuid,
        64,
        '(unknown provider)',
      )}`,
    );
  }

  lines.push(
    `  Manifest:                  ${manifestLine}`,
    `  meta_hash:                 ${input.metaHash}`,
  );

  if (hasDomain) {
    const target =
      typeof input.customDomainService === 'string' &&
      input.customDomainService.length > 0
        ? `-> service ${input.customDomainService}`
        : '-> single-service lease';
    lines.push(`  Custom domain:             ${input.customDomain} ${target}`);
  }

  lines.push(
    `  SKU price:                 ${formatSkuPrice(input.plan, denomMap)}`,
  );

  if (hasDomain) {
    // Two-tx layout: labeled lines + Total fee. Honors approach-3
    // `notEstimated` sentinel for set-domain pre-broadcast estimation
    // fallback (no representative lease).
    const setDomain = input.plan.fees.setDomain;
    let setDomainLine: string;
    // Capture the typed `FeeEstimate` reference (when the set-domain
    // fee is a real estimate, not the sentinel) so the total-line
    // BigInt sum can operate on `coins` directly via `sumFees`. The
    // prior code parsed humanized strings to float64 — see
    // `sumFees`'s docstring for the precision-loss rationale.
    let setDomainReal: FeeEstimate | null = null;
    if (setDomain === undefined) {
      setDomainLine =
        '(not estimated — agent skipped pre-broadcast simulation, policy violation)';
    } else if ('notEstimated' in setDomain) {
      setDomainLine = `(not estimated — ${setDomain.reason})`;
    } else {
      setDomainReal = setDomain;
      setDomainLine = formatFeeLine(
        humanizeFeeAmount(setDomain, denomMap),
        setDomain.gas,
      );
    }

    lines.push(`  Tx fee (create-lease):     ${createFeeLine}`);
    lines.push(`  Tx fee (set-domain):       ${setDomainLine}`);

    // Total only when both fees are real numbers. Sentinel set-domain
    // fees fall through to the placeholder.
    const totalLine =
      setDomainReal !== null
        ? sumFees(createFee, setDomainReal, denomMap)
        : '(partial — see fee lines above)';
    lines.push(`  Total fee:                 ${totalLine}`);
  } else {
    lines.push(`  Tx fee:                    ${createFeeLine}`);
  }

  lines.push(
    `  Wallet:                    ${formatWallet(input.plan, denomMap)}`,
  );
  lines.push(
    `  Credits:                   ${formatCredits(input.plan, denomMap)}`,
  );

  return { text: lines.join('\n') };
}
