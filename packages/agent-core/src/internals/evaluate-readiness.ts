import type { Coin, Readiness, ReadinessAction } from '../types.js';
import {
  type DenomMap,
  denomToSymbol,
  humanizeCoin,
  loadChainDenomMap,
} from './humanize-denom.js';

/**
 * Evaluate `check_deployment_readiness` MCP response data into the frozen
 * `Readiness` shape. Port of `manifest-agent-plugin/scripts/evaluate-readiness.cjs`
 * adapted to camelCase typed input + the `Readiness` contract from ENG-128.
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
 * `available_sku_names`, `current_balance`); the TS-port input is
 * camelCase, and high-level callers (PR 3's `deployApp`) translate the
 * snake_case wire shape into camelCase before passing in.
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
  /** All active SKU names the chain currently advertises. */
  availableSkuNames: string[];
  /** Gas-price string (e.g. `'1umfx'`, `'0.37upwr'`). Required — drives the wallet-gas check denom. */
  gasPrice: string;
  /** Override the per-denom warn floor (smallest unit). When omitted, uses the per-denom default or 50_000n fallback. */
  gasWarnFloor?: bigint;
  /** Optional path to `$MANIFEST_PLUGIN_DATA/chains/<chain>.json` for symbol humanization. */
  chainDataFile?: string;
  /** Pre-loaded DenomMap. Wins over `chainDataFile` when both are supplied. */
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

  // --- Load denom map (or use injected) ---
  const denomMap = inputs.denomMap ?? loadChainDenomMap(inputs.chainDataFile);

  // --- Walk readiness rules ---
  const reasons: string[] = [];
  const actions = new Set<ReadinessAction>();
  let status: Readiness['status'] = 'ok';

  // 1. SKU availability — hard block when the user's chosen size isn't offered.
  if (inputs.size !== null && !inputs.availableSkuNames.includes(inputs.size)) {
    status = 'block';
    const available =
      inputs.availableSkuNames.length > 0
        ? inputs.availableSkuNames.join(', ')
        : '(none)';
    reasons.push(
      `Requested SKU "${inputs.size}" is not currently offered. Available: ${available}.`,
    );
    actions.add('pick_different_sku');
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
  if (credits === null) {
    if (status === 'ok') status = 'warn';
    reasons.push('No credit account funded for compute leases.');
    actions.add('fund_credit');
  } else if (
    inputs.sku !== null &&
    inputs.sku.price.amount.length > 0 &&
    inputs.sku.price.denom.length > 0
  ) {
    const skuPrice = inputs.sku.price;
    const creditBalances: Coin[] = Array.isArray(credits.availableBalances)
      ? credits.availableBalances
      : Array.isArray(credits.balances)
        ? credits.balances
        : Array.isArray(credits.currentBalance)
          ? credits.currentBalance
          : [];
    const creditEntry = creditBalances.find((b) => b.denom === skuPrice.denom);
    const pricePerHour = asBigInt(skuPrice.amount);
    if (creditEntry === undefined) {
      // The credit account has NO entry in the SKU's price denom. Distinct
      // from "credits ran out" — usually means credits are funded in a
      // different denom than the SKU charges in. Emit a specific
      // diagnostic so the user knows to fund_credit in the right denom
      // rather than seeing a false "0 hours of runtime" warning.
      const fundedDenoms = creditBalances
        .map((b) => b.denom)
        .filter((d): d is string => typeof d === 'string' && d.length > 0);
      const skuSymbol = denomToSymbol(skuPrice.denom, denomMap);
      const fundedSymbols = fundedDenoms.map((d) => denomToSymbol(d, denomMap));
      if (status === 'ok') status = 'warn';
      reasons.push(
        fundedDenoms.length > 0
          ? `Credit account has no ${skuSymbol} balance (the ${inputs.sku.name} SKU charges in ${skuSymbol}; account holds ${fundedSymbols.join(
              ', ',
            )}). Fund ${skuSymbol} credits before deploying.`
          : `Credit account is empty for the ${inputs.sku.name} SKU's ${skuSymbol} denom. Fund ${skuSymbol} credits before deploying.`,
      );
      actions.add('fund_credit');
    } else if (pricePerHour > 0n) {
      const creditAmount = asBigInt(creditEntry.amount);
      // Convert via Number for the human-readable hours figure. Credit
      // amounts are in the chain's smallest unit and bounded well below
      // Number.MAX_SAFE_INTEGER for any realistic balance.
      const hrsForThisSku = Number(creditAmount) / Number(pricePerHour);
      if (hrsForThisSku < HOURS_REMAINING_WARN_FLOOR) {
        if (status === 'ok') status = 'warn';
        reasons.push(
          `Credits cover ~${hrsForThisSku.toFixed(1)}h of runtime at the ${inputs.sku.name} SKU (${humanizeCoin(
            creditAmount.toString(),
            skuPrice.denom,
            denomMap,
          )} / ${humanizeCoin(
            pricePerHour.toString(),
            skuPrice.denom,
            denomMap,
          )} per hour); below the ${HOURS_REMAINING_WARN_FLOOR}h floor.`,
        );
        actions.add('fund_credit');
      }
    }
  } else if (credits.hoursRemaining !== undefined) {
    // Fallback for cases where SKU pricing is not available (e.g. caller
    // didn't pass --size). Use the chain's hoursRemaining but ONLY warn
    // when it's a meaningful positive number below the floor — `0` here
    // means "no current burn", not "low credits".
    const hrs = Number(credits.hoursRemaining);
    if (Number.isFinite(hrs) && hrs > 0 && hrs < HOURS_REMAINING_WARN_FLOOR) {
      if (status === 'ok') status = 'warn';
      reasons.push(
        `Credits cover ~${hrs.toFixed(1)}h of runtime at the current burn rate; below the ${HOURS_REMAINING_WARN_FLOOR}h floor.`,
      );
      actions.add('fund_credit');
    }
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
