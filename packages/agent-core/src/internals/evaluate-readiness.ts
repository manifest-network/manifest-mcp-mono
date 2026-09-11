import { sanitizeForDisplay } from '@manifest-network/manifest-mcp-core';
import type {
  Coin,
  PlannedLeaseItem,
  Readiness,
  ReadinessAction,
} from '../types.js';
import {
  type DenomMap,
  denomToSymbol,
  EMPTY_DENOM_MAP,
  humanizeCoin,
} from './humanize-denom.js';
import { summarizeRecurringCosts } from './recurring-costs.js';

/**
 * Evaluate `check_deployment_readiness` MCP response data into the frozen
 * `Readiness` shape (camelCase typed input + the `Readiness` contract from
 * ENG-128).
 *
 * Thresholds are encoded here (not in skill prose or caller config) so the
 * rules stay consistent across runs:
 *   - HOURS_REMAINING_WARN_FLOOR = 24
 *   - GAS_BALANCE_WARN_FLOOR (per-denom) = 50_000n umfx | upwr
 *
 * Status semantics (CJS-parity):
 *   - `'block'` — cannot proceed (SKU unavailable, wallet empty)
 *   - `'warn'`  — proceedable but risky (low credits, low gas balance, no credit account)
 *   - `'ok'`    — silent pass
 *
 * `suggestedActions` are semantic tokens from the frozen `ReadinessAction`
 * union — not prose for the user. Surfaces map these to UI affordances.
 *
 * Walked-from-CJS field-rename: the MCP response uses snake_case
 * (`wallet_balances`, `available_balances`, `hours_remaining`,
 * `current_balance`); the TS-port input is camelCase, and high-level
 * callers (PR 3's `deployApp`) translate the snake_case wire shape into
 * camelCase before passing in. ENG-258 Task 15 replaced the old flat
 * names field with `skuCandidates` / `availableSkuNames` derived from
 * `available_skus`.
 */

const HOURS_REMAINING_WARN_FLOOR = 24;

// Per-denom warn floors for low gas balance (in smallest unit). Mirrors the
// CJS values: 50_000 umfx = 0.05 MFX (1 MFX = 1,000,000 umfx); comparable
// headroom for upwr.
const GAS_BALANCE_WARN_FLOOR_DEFAULTS: Readonly<Record<string, bigint>> = {
  umfx: 50_000n,
  upwr: 50_000n,
};
const GAS_BALANCE_WARN_FLOOR_FALLBACK = 50_000n;

/**
 * Cosmos convention for gas-price strings: leading numeric (digits +
 * optional decimal point), then the denom. Denom grammar mirrors
 * `sdk.ValidateDenom`: `[a-zA-Z][a-zA-Z0-9/:._-]{2,127}`.
 * Anchored both ends so trailing whitespace fails fast.
 */
const GAS_PRICE_RE = /^[0-9]+(?:\.[0-9]+)?([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/;

/**
 * Inputs passed to `evaluateReadiness`. camelCase throughout — high-level
 * callers translate the snake_case MCP response shape before invocation.
 */
export interface EvaluateReadinessInputs {
  /** Tenant address (bech32). Not consumed by the algorithm; included for journal/log context. */
  tenant: string;
  /** Image ref being considered (may be `null` when only the size is selected). */
  image: string | null;
  /** SKU size string the caller wants (`'docker-micro'`, etc.). `null` when not yet chosen. */
  size: string | null;
  /** Wallet bank balances. */
  walletBalances: Coin[];
  /** Credit account data, or `null` when no credit account is funded. */
  credits: {
    availableBalances?: Coin[];
    /** Older response variant — fallback when `availableBalances` is absent. */
    balances?: Coin[];
    /** Live current credit balance(s) when the tenant has at least one active lease. */
    currentBalance?: Coin[];
    /** Hours of runtime at the user's current overall burn rate (string-encoded number). */
    hoursRemaining?: string;
  } | null;
  /** Chosen SKU + price, or `null` when no size selected. */
  sku: { name: string; price: Coin } | null;
  /** Resolved create-lease items, including storage and every service quantity. */
  leaseItems: readonly PlannedLeaseItem[];
  /** All active SKU names the chain currently advertises. */
  availableSkuNames: string[];
  /**
   * Structured candidates for `size` (name + provider). When present, this is
   * preferred over `availableSkuNames` for the SKU-availability gate (ENG-258).
   */
  skuCandidates?: { name: string; providerUuid: string; price?: Coin }[];
  /**
   * Provider the caller pinned (if any). When `skuCandidates` is set, the
   * gate requires at least one candidate whose `providerUuid` matches (ENG-258).
   */
  requestedProviderUuid?: string;
  /** Gas-price string (e.g. `'1umfx'`, `'0.37upwr'`). Required — drives the wallet-gas check denom. */
  gasPrice: string;
  /** Override the per-denom warn floor (smallest unit). When omitted, uses the per-denom default or 50_000n fallback. */
  gasWarnFloor?: bigint;
  /**
   * Pre-loaded `DenomMap` for symbol humanization. The orchestrator
   * (`deploy-app.ts` and PR-4 callers) is responsible for composing the
   * map via `loadChainDenomMap(chainDataFile)` and passing it in. This
   * keeps `evaluateReadiness` pure-sync — I/O lives at the orchestrator
   * boundary, not inside the decision function (post-Q4 Bii verdict).
   *
   * When omitted, the no-op map is used; balances + SKU prices render
   * with raw on-chain denoms.
   */
  denomMap?: DenomMap;
}

/**
 * Compute the `Readiness` verdict for a prospective deployment.
 *
 * Throws `TypeError` on malformed `gasPrice` (the only input field whose
 * runtime shape isn't enforced by the typed signature).
 */
export function evaluateReadiness(inputs: EvaluateReadinessInputs): Readiness {
  // --- Parse + validate gasPrice via String.match (avoids RegExp.exec) ---
  const gasDenomMatch = inputs.gasPrice.match(GAS_PRICE_RE);
  if (!gasDenomMatch || gasDenomMatch[1] === undefined) {
    throw new TypeError(
      `evaluateReadiness: gasPrice must match <numeric><denom> (e.g. "1umfx" or "0.37upwr"); got "${inputs.gasPrice}"`,
    );
  }
  const gasDenom = gasDenomMatch[1];

  // --- Resolve gas warn floor ---
  const gasWarnFloor =
    inputs.gasWarnFloor !== undefined
      ? validateGasWarnFloor(inputs.gasWarnFloor)
      : (GAS_BALANCE_WARN_FLOOR_DEFAULTS[gasDenom] ??
        GAS_BALANCE_WARN_FLOOR_FALLBACK);

  // --- Resolve denom map ---
  // Pure-sync decision function: callers pre-load the map via
  // `loadChainDenomMap(chainDataFile)` and pass it in. When absent, the
  // empty no-op map is used (raw on-chain denom rendering downstream).
  // See Q4 Bii rationale in EvaluateReadinessInputs.denomMap docstring.
  const denomMap = inputs.denomMap ?? EMPTY_DENOM_MAP;

  // --- Walk readiness rules ---
  const reasons: string[] = [];
  const actions = new Set<ReadinessAction>();
  let status: Readiness['status'] = 'ok';

  // 1. SKU availability — block when the chosen size (+ provider) has no candidate.
  if (inputs.size !== null) {
    const candidates = inputs.skuCandidates;
    let available: boolean;
    if (candidates !== undefined) {
      // Candidate-based gate (ENG-258): prefer the structured list when present.
      available = candidates.some(
        (c) =>
          c.name === inputs.size &&
          (inputs.requestedProviderUuid === undefined ||
            c.providerUuid === inputs.requestedProviderUuid),
      );
    } else {
      // Legacy fallback: plain name list when no candidates supplied.
      available = inputs.availableSkuNames.includes(inputs.size);
    }
    if (!available) {
      status = 'block';
      if (candidates !== undefined) {
        // Candidate-based message (ENG-258): include the requested provider hint.
        const hint = inputs.requestedProviderUuid
          ? ` on provider ${inputs.requestedProviderUuid}`
          : '';
        reasons.push(
          `Requested SKU "${inputs.size}"${hint} is not currently offered.`,
        );
      } else {
        // Legacy message: include the available list for discoverability.
        const availableDisplay =
          inputs.availableSkuNames.length > 0
            ? inputs.availableSkuNames.join(', ')
            : '(none)';
        reasons.push(
          `Requested SKU "${inputs.size}" is not currently offered. Available: ${availableDisplay}.`,
        );
      }
      actions.add('pick_different_sku');
    }
  }

  // 2. Wallet gas balance — hard block on absent/zero, warn on below-floor.
  const gasEntry = inputs.walletBalances.find((b) => b.denom === gasDenom);
  const gasAmount = gasEntry ? asBigInt(gasEntry.amount) : 0n;
  if (inputs.walletBalances.length === 0 || gasAmount === 0n) {
    status = 'block';
    reasons.push(
      `Wallet has no ${denomToSymbol(gasDenom, denomMap)} balance for gas.`,
    );
    actions.add('request_faucet');
    actions.add('topup_wallet');
  } else if (gasAmount < gasWarnFloor) {
    if (status === 'ok') status = 'warn';
    reasons.push(
      `Wallet balance (${humanizeCoin(
        gasAmount.toString(),
        gasDenom,
        denomMap,
      )}) is below ${humanizeCoin(
        gasWarnFloor.toString(),
        gasDenom,
        denomMap,
      )}; broadcast may run out of gas.`,
    );
    actions.add('topup_wallet');
  }

  // 3. Credits.
  //
  // CJS preserves a subtle source-of-truth selection: `credits.availableBalances`
  // is the "right now" balance net of pending reservations; `credits.balances`
  // (older variant) is the gross-funded fallback; `currentBalance` is from
  // the chain's credit estimator and is only present when the tenant has at
  // least one ACTIVE lease. A fresh deployer with credits but no active
  // leases would have `currentBalance` ABSENT — reading that field FIRST as
  // the credit source produces a false "Credit account is empty" warning.
  // Mirror the CJS precedence: availableBalances → balances → currentBalance.
  const credits = inputs.credits;
  const { unit, totals, unpricedItemCount } = summarizeRecurringCosts(
    inputs.leaseItems,
  );
  if (credits === null) {
    if (status === 'ok') status = 'warn';
    reasons.push('No credit account funded for deployment lease items.');
    actions.add('fund_credit');
  } else {
    const creditBalances: Coin[] = Array.isArray(credits.availableBalances)
      ? credits.availableBalances
      : Array.isArray(credits.balances)
        ? credits.balances
        : Array.isArray(credits.currentBalance)
          ? credits.currentBalance
          : [];
    for (const { denom, amount } of totals) {
      if (amount === 0n) continue;
      const creditEntry = creditBalances.find((b) => b.denom === denom);
      const symbol = sanitizeForDisplay(denomToSymbol(denom, denomMap));
      if (creditEntry === undefined) {
        const fundedSymbols = creditBalances.map((b) =>
          sanitizeForDisplay(denomToSymbol(b.denom, denomMap)),
        );
        if (status === 'ok') status = 'warn';
        reasons.push(
          fundedSymbols.length > 0
            ? `Credit account has no ${symbol} balance (this deployment charges in ${symbol}; account holds ${fundedSymbols.join(', ')}). Fund ${symbol} credits before deploying.`
            : `Credit account is empty for this deployment's ${symbol} denom. Fund ${symbol} credits before deploying.`,
        );
        actions.add('fund_credit');
        continue;
      }
      const balance = asBigInt(creditEntry.amount);
      const creditAmount = balance > 0n ? balance : 0n;
      const hoursPerPeriod = unit === 'day' ? 24n : 1n;
      // Compare in integer units before rounding the display. This keeps
      // the 24h boundary exact even for amounts above Number.MAX_SAFE_INTEGER.
      if (
        creditAmount * hoursPerPeriod <
        amount * BigInt(HOURS_REMAINING_WARN_FLOOR)
      ) {
        const tenths =
          (creditAmount * hoursPerPeriod * 10n + amount / 2n) / amount;
        const hours = `${tenths / 10n}.${tenths % 10n}`;
        if (status === 'ok') status = 'warn';
        reasons.push(
          `Credits cover ~${hours}h of runtime for this deployment (${sanitizeForDisplay(humanizeCoin(creditAmount.toString(), denom, denomMap))} / ${sanitizeForDisplay(humanizeCoin(amount.toString(), denom, denomMap))} per ${unit}); below the ${HOURS_REMAINING_WARN_FLOOR}h floor.`,
        );
        actions.add('fund_credit');
      }
    }
    // With no selected lease items, the current burn rate remains a useful
    // fallback. Never substitute it for an unpriced prospective deployment.
    if (
      inputs.leaseItems.length === 0 &&
      credits.hoursRemaining !== undefined
    ) {
      const hrs = Number(credits.hoursRemaining);
      if (Number.isFinite(hrs) && hrs > 0 && hrs < HOURS_REMAINING_WARN_FLOOR) {
        if (status === 'ok') status = 'warn';
        reasons.push(
          `Credits cover ~${hrs.toFixed(1)}h of runtime at the current burn rate; below the ${HOURS_REMAINING_WARN_FLOOR}h floor.`,
        );
        actions.add('fund_credit');
      }
    }
  }
  if (unpricedItemCount > 0) {
    if (status === 'ok') status = 'warn';
    reasons.push(
      `Cannot fully estimate deployment runtime: ${unpricedItemCount} lease ${unpricedItemCount === 1 ? 'item has' : 'items have'} an unknown price or billing unit.`,
    );
  }

  // --- Map input shape into the frozen `Readiness` carrier fields ---
  const creditsOut: Readiness['credits'] =
    credits === null
      ? null
      : {
          availableBalances: Array.isArray(credits.availableBalances)
            ? credits.availableBalances
            : Array.isArray(credits.balances)
              ? credits.balances
              : Array.isArray(credits.currentBalance)
                ? credits.currentBalance
                : [],
        };

  return {
    status,
    reasons,
    suggestedActions: Array.from(actions),
    walletBalances: inputs.walletBalances,
    credits: creditsOut,
    sku: inputs.sku,
  };
}

function asBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

function validateGasWarnFloor(value: bigint): bigint {
  if (value < 0n) {
    throw new TypeError(
      `evaluateReadiness: gasWarnFloor must be a non-negative integer, got ${value}`,
    );
  }
  return value;
}
