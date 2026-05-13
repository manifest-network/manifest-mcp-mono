import type { DeploymentPlanBlock, FeeEstimate, Plan } from '../types.js';
import {
  type DenomMap,
  EMPTY_DENOM_MAP,
  humanizeBalances,
  humanizeCoin,
} from './humanize-denom.js';

/**
 * Render the canonical `DeploymentPlan` block for `deployApp`'s
 * confirmation step. Port of
 * `manifest-agent-plugin/scripts/render-deployment-plan.cjs` (plugin git-hash
 * `3a33e80`) adapted to the typed `Plan` + new `FeeEstimate {coins, gas}`
 * shape introduced in `a62cfd1` (post-PR-2 frozen-contract revision).
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
 * Provider line is intentionally absent (chain selects internally; format-
 * success.ts emits it post-deploy).
 */

/** Maximum decimals in a humanized fee string, for same-denom summing. */
function decimalDigits(s: string): number {
  const m = s.trim().match(/^[0-9]+(?:\.([0-9]+))?/);
  return m && m[1] ? m[1].length : 0;
}

/**
 * Parse `"<amount> <denom>"` → `[number, denom]` or `null` when shape
 * doesn't match (multi-coin "<a>, <b>" form, "(empty)", etc.).
 */
function parseHumanFee(s: string): [number, string] | null {
  if (typeof s !== 'string') return null;
  // String.match avoids the alternative RegExp pattern that the CI
  // security hook treats as a child_process token (see ENG-129 task #34).
  const m = s.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s+(\S+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return [n, m[2] ?? ''];
}

/**
 * Same-denom: numeric sum, formatted at max input precision so neither
 * input's decimals are lost. Different-denom: `"<a> + <b>"` concat.
 * Mirrors the CJS's `sumHumanFees` semantics.
 */
function sumHumanFees(a: string, b: string): string {
  const pa = parseHumanFee(a);
  const pb = parseHumanFee(b);
  if (pa !== null && pb !== null && pa[1] === pb[1]) {
    const maxDec = Math.max(decimalDigits(a), decimalDigits(b));
    return `${(pa[0] + pb[0]).toFixed(maxDec)} ${pa[1]}`;
  }
  return `${a} + ${b}`;
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
  return `${humanizeCoin(sku.price.amount, sku.price.denom, denomMap)} / hour`;
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

  const lines: string[] = [
    'DeploymentPlan',
    `  Image:                     ${input.image}`,
    `  Size:                      ${input.size}`,
    `  Manifest:                  ${manifestLine}`,
    `  meta_hash:                 ${input.metaHash}`,
  ];

  if (hasDomain) {
    const target =
      typeof input.customDomainService === 'string' &&
      input.customDomainService.length > 0
        ? `-> service ${input.customDomainService}`
        : '-> single-service lease';
    lines.push(`  Custom domain:             ${input.customDomain} ${target}`);
  }

  lines.push(`  SKU price:                 ${formatSkuPrice(input.plan, denomMap)}`);

  if (hasDomain) {
    // Two-tx layout: labeled lines + Total fee. Honors approach-3
    // `notEstimated` sentinel for set-domain pre-broadcast estimation
    // fallback (no representative lease).
    const setDomain = input.plan.fees.setDomain;
    let setDomainLine: string;
    let setDomainHuman: string | null = null;
    if (setDomain === undefined) {
      setDomainLine = '(not estimated — agent skipped pre-broadcast simulation, policy violation)';
    } else if ('notEstimated' in setDomain) {
      setDomainLine = `(not estimated — ${setDomain.reason})`;
    } else {
      setDomainHuman = humanizeFeeAmount(setDomain, denomMap);
      setDomainLine = formatFeeLine(setDomainHuman, setDomain.gas);
    }

    lines.push(`  Tx fee (create-lease):     ${createFeeLine}`);
    lines.push(`  Tx fee (set-domain):       ${setDomainLine}`);

    // Total only when both fees are real numbers. Sentinel set-domain
    // fees fall through to the placeholder.
    const totalLine =
      setDomainHuman !== null
        ? sumHumanFees(createHuman, setDomainHuman)
        : '(partial — see fee lines above)';
    lines.push(`  Total fee:                 ${totalLine}`);
  } else {
    lines.push(`  Tx fee:                    ${createFeeLine}`);
  }

  lines.push(`  Wallet:                    ${formatWallet(input.plan, denomMap)}`);
  lines.push(`  Credits:                   ${formatCredits(input.plan, denomMap)}`);

  return { text: lines.join('\n') };
}
