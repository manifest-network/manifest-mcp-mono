/**
 * Translator: fred's `CheckDeploymentReadinessResult` (snake_case wire
 * shape) → canonical `evaluateReadiness`'s `EvaluateReadinessInputs`
 * (camelCase + deploy-app context). ENG-185 sub-PR B, item 1.
 *
 * Replaces the always-`'ok'` stub `evaluateReadinessFromRaw` previously
 * inlined in `deploy-app.ts`. With this translator wired in, the
 * `status === 'block'` short-circuit at BOTH call sites
 * (`deploy-app.ts` L207 initial-spec + L327 post-edit recall) fires
 * correctly, killing the silent "always proceed" path the stub kept open.
 *
 * Three concerns the translator owns:
 *
 *   1. **Field renames** — snake_case → camelCase across all 9 fred
 *      top-level fields the evaluator consumes (`wallet_balances` →
 *      `walletBalances`, `available_sku_names` → `availableSkuNames`,
 *      `credits.available_balances` → `credits.availableBalances`, etc.).
 *
 *   2. **Folding top-level → nested** — fred's `getBalance` emits
 *      `current_balance` and `hours_remaining` ALONGSIDE `credits`
 *      (top-level on the response); the evaluator's input nests them
 *      INSIDE `credits` as `currentBalance` / `hoursRemaining`. The
 *      translator moves them across the boundary.
 *
 *      Guard: when fred returns `credits: null`, the translator
 *      preserves null — synthesizing a credits object from the stray
 *      top-level fields would bypass the evaluator's
 *      `credits === null` warn rule ("No credit account funded for
 *      compute leases").
 *
 *   3. **Context injection** — `gasPrice`, `denomMap`, and `tenant`
 *      come from the orchestrator's scope (not from fred). For
 *      `tenant`, the translator deliberately IGNORES `raw.tenant` and
 *      uses the `tenantAddress` arg: the orchestrator already resolved
 *      and validated the canonical wallet/client address via the
 *      address-source consistency guard (deploy-app.ts L154-161).
 *
 * Also: drops fred sku fields `uuid` / `provider_uuid` / `active` (the
 * evaluator only needs `name` + `price`), and coerces a price-less
 * SKU to `null` — `EvaluateReadinessInputs.sku` requires `price: Coin`,
 * so an SKU without price is structurally not a valid input.
 */

import type { CheckDeploymentReadinessResult } from '@manifest-network/manifest-mcp-fred';
import type { Coin, Readiness } from '../types.js';
import {
  type EvaluateReadinessInputs,
  evaluateReadiness,
} from './evaluate-readiness.js';
import type { DenomMap } from './humanize-denom.js';

/**
 * Translate fred's snake_case `CheckDeploymentReadinessResult` into
 * the canonical `EvaluateReadinessInputs` (camelCase + context) and
 * invoke `evaluateReadiness`. Returns the typed `Readiness` verdict
 * the orchestrator gates on (`status === 'block'` → INVALID_CONFIG).
 *
 * @param raw            fred's wire response (snake_case, readonly).
 * @param gasPrice       Gas-price string from `clientManager.getConfig().gasPrice`
 *                       (e.g. `'1umfx'`). Required by the evaluator's
 *                       wallet-gas check; defaulted upstream when absent.
 * @param denomMap       Pre-loaded `DenomMap` for humanization. Pass
 *                       `EMPTY_DENOM_MAP` when no chain-data file is
 *                       configured.
 * @param tenantAddress  Canonical tenant address from the orchestrator's
 *                       address-source consistency guard. PREFERRED over
 *                       `raw.tenant` so a fred response whose `tenant`
 *                       differs (configuration drift / replayed mock)
 *                       does NOT silently route the verdict against a
 *                       different wallet.
 */
export function evaluateReadinessFromFredResponse(
  raw: CheckDeploymentReadinessResult,
  gasPrice: string,
  denomMap: DenomMap,
  tenantAddress: string,
): Readiness {
  return evaluateReadiness({
    tenant: tenantAddress,
    image: raw.image,
    size: raw.size,
    walletBalances: toCoinArray(raw.wallet_balances),
    credits: translateCredits(raw),
    sku: translateSku(raw.sku),
    availableSkuNames: [...raw.available_sku_names],
    gasPrice,
    denomMap,
  });
}

/**
 * Translate fred's `credits` object + top-level `current_balance` /
 * `hours_remaining` into the evaluator's nested `credits` input shape.
 *
 * Null preservation: when fred returns `credits: null`, the translator
 * returns null even if `current_balance` / `hours_remaining` are
 * present at the top level — synthesizing a credits object from the
 * stray fields would suppress the "no credit account funded" warn
 * rule the evaluator owns.
 */
function translateCredits(
  raw: CheckDeploymentReadinessResult,
): EvaluateReadinessInputs['credits'] {
  if (raw.credits === null) return null;
  // Defensive emission: only write a field when fred actually supplied
  // it. Fred's `CheckDeploymentReadinessResult` declares `balances` /
  // `available_balances` as required, but the evaluator's input shape
  // accepts both as OPTIONAL — and skipping the field on absent input
  // is preferable to surfacing a `.map of undefined` crash if a mock or
  // upstream variant elides the field. The evaluator's source-of-truth
  // precedence (availableBalances → balances → currentBalance → []) is
  // already CJS-parity-correct for partial credits objects.
  const out: NonNullable<EvaluateReadinessInputs['credits']> = {};
  if (Array.isArray(raw.credits.available_balances)) {
    out.availableBalances = toCoinArray(raw.credits.available_balances);
  }
  if (Array.isArray(raw.credits.balances)) {
    out.balances = toCoinArray(raw.credits.balances);
  }
  if (raw.current_balance !== undefined) {
    out.currentBalance = toCoinArray(raw.current_balance);
  }
  if (raw.hours_remaining !== undefined) {
    out.hoursRemaining = raw.hours_remaining;
  }
  return out;
}

/**
 * Translate fred's `SkuSummary | null` into the evaluator's
 * `{ name: string; price: Coin } | null`.
 *
 * Drops fred-only fields (`uuid`, `provider_uuid`, `active`). Coerces
 * a price-less SKU to `null` — the evaluator's `sku.price` is required
 * (`Coin`), so an SKU without price is structurally invalid input.
 * Without this coercion the evaluator would treat the SKU as truthy
 * and crash accessing `price.amount`.
 */
function translateSku(
  sku: CheckDeploymentReadinessResult['sku'],
): EvaluateReadinessInputs['sku'] {
  if (sku === null) return null;
  if (sku.price === undefined) return null;
  return {
    name: sku.name,
    price: { denom: sku.price.denom, amount: sku.price.amount },
  };
}

/**
 * Spread a readonly Coin-shaped array into a mutable Coin[]. The
 * evaluator's `EvaluateReadinessInputs.walletBalances` / credit-balance
 * arrays are mutable; fred's wire shapes are `ReadonlyArray<...>`. A
 * shallow copy is sufficient — each element is a frozen-ish `{denom,
 * amount}` value tuple, never mutated by the evaluator.
 */
function toCoinArray(
  arr: ReadonlyArray<{ readonly denom: string; readonly amount: string }>,
): Coin[] {
  return arr.map((c) => ({ denom: c.denom, amount: c.amount }));
}
