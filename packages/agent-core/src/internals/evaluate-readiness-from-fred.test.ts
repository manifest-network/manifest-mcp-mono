import type { CheckDeploymentReadinessResult } from '@manifest-network/manifest-mcp-fred';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as evalMod from './evaluate-readiness.js';
import { evaluateReadinessFromFredResponse } from './evaluate-readiness-from-fred.js';
import { EMPTY_DENOM_MAP } from './humanize-denom.js';

// ENG-185 sub-PR B item 1 — translator from fred's snake_case wire shape
// (`CheckDeploymentReadinessResult`) to the canonical `evaluateReadiness`'s
// camelCase `EvaluateReadinessInputs`. The translator MUST:
//
//   - Rename `wallet_balances` → `walletBalances`, `available_sku_names`
//     → `availableSkuNames`, `credits.available_balances` →
//     `credits.availableBalances`, `credits.balances` → `credits.balances`.
//   - FOLD top-level `current_balance` and `hours_remaining` INTO the
//     `credits` sub-object as `currentBalance` / `hoursRemaining` (they
//     live at the fred top level but are nested under `credits` in the
//     evaluator's input contract).
//   - Drop fred's `sku.uuid` / `sku.provider_uuid` / `sku.active`; keep
//     `name` + `price` only. A fred `sku` with no `price` MUST be coerced
//     to `null` (EvaluateReadinessInputs.sku requires `price: Coin`).
//   - Inject `gasPrice`, `denomMap`, and `tenant` from deploy-app context;
//     IGNORE `raw.tenant` (fred provides it, but the orchestrator already
//     resolved the canonical `tenantAddress` via the wallet/client guard).
//   - Spread readonly arrays to mutable copies (Coin[] / string[]).

// Spy on the canonical evaluator so we can assert the camelCase input
// shape the translator produces, independent of evaluator's own logic.
vi.mock('./evaluate-readiness.js', async () => {
  const actual = await vi.importActual<typeof evalMod>(
    './evaluate-readiness.js',
  );
  return {
    ...actual,
    evaluateReadiness: vi.fn(actual.evaluateReadiness),
  };
});

function fredResponse(
  overrides: Partial<CheckDeploymentReadinessResult> = {},
): CheckDeploymentReadinessResult {
  return {
    tenant: 'manifest1fred',
    image: 'docker.io/library/nginx:1.27',
    size: 'small',
    wallet_balances: [{ denom: 'umfx', amount: '10000000' }],
    credits: {
      active_leases: '0',
      pending_leases: '0',
      reserved_amounts: [],
      balances: [{ denom: 'umfx', amount: '50000000000' }],
      available_balances: [{ denom: 'umfx', amount: '50000000000' }],
    },
    sku: {
      name: 'small',
      uuid: 'sku-uuid-fixture',
      provider_uuid: 'prov-uuid-fixture',
      price: { denom: 'umfx', amount: '1000' },
      active: true,
    },
    available_sku_names: ['small', 'medium'],
    ready: true,
    missing_steps: [],
    ...overrides,
  } as CheckDeploymentReadinessResult;
}

describe('evaluateReadinessFromFredResponse — field mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renames the top-level snake_case fields to camelCase', () => {
    const raw = fredResponse();
    evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1context',
    );
    expect(evalMod.evaluateReadiness).toHaveBeenCalledTimes(1);
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.image).toBe('docker.io/library/nginx:1.27');
    expect(input?.size).toBe('small');
    expect(input?.walletBalances).toEqual([
      { denom: 'umfx', amount: '10000000' },
    ]);
    expect(input?.availableSkuNames).toEqual(['small', 'medium']);
  });

  it('renames credits.available_balances and credits.balances to camelCase', () => {
    const raw = fredResponse();
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.credits?.availableBalances).toEqual([
      { denom: 'umfx', amount: '50000000000' },
    ]);
    expect(input?.credits?.balances).toEqual([
      { denom: 'umfx', amount: '50000000000' },
    ]);
  });

  it('folds top-level `current_balance` into `credits.currentBalance`', () => {
    // fred's `getBalance` emits `current_balance` ALONGSIDE `credits`
    // (not nested inside it); the evaluator expects it nested. The
    // translator folds the field across the boundary.
    const raw = fredResponse({
      current_balance: [{ denom: 'umfx', amount: '12345' }],
    });
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.credits?.currentBalance).toEqual([
      { denom: 'umfx', amount: '12345' },
    ]);
  });

  it('folds top-level `hours_remaining` into `credits.hoursRemaining`', () => {
    const raw = fredResponse({ hours_remaining: '42.7' });
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.credits?.hoursRemaining).toBe('42.7');
  });

  it('passes `credits: null` through unchanged', () => {
    const raw = fredResponse({ credits: null });
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.credits).toBeNull();
  });

  it('omits credits fields fred did not supply (defensive against partial credits objects)', () => {
    // Some mocks / older fred variants emit only `available_balances`
    // without `balances` (the canonical happy-path fixture does this).
    // The translator emits ONLY the fields that were present — the
    // evaluator's source-of-truth precedence handles partial objects
    // (availableBalances → balances → currentBalance → []).
    const raw = fredResponse({
      credits: {
        active_leases: '0',
        pending_leases: '0',
        reserved_amounts: [],
        available_balances: [{ denom: 'umfx', amount: '50000000000' }],
      } as unknown as CheckDeploymentReadinessResult['credits'],
    });
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.credits?.availableBalances).toEqual([
      { denom: 'umfx', amount: '50000000000' },
    ]);
    expect(input?.credits).not.toHaveProperty('balances');
  });

  it('preserves `credits: null` even when top-level `current_balance`/`hours_remaining` are present', () => {
    // Unlikely combination per fred's getBalance (estimate only emits when
    // credits exist), but defensive: a null credits MUST stay null —
    // synthesizing a credits object from the stray top-level fields would
    // bypass `evaluateReadiness`'s `credits === null` warn rule ("No
    // credit account funded for compute leases").
    const raw = fredResponse({
      credits: null,
      current_balance: [{ denom: 'umfx', amount: '999' }],
      hours_remaining: '10',
    });
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.credits).toBeNull();
  });

  it('drops fred sku.uuid / sku.provider_uuid / sku.active; keeps name + price', () => {
    const raw = fredResponse();
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.sku).toEqual({
      name: 'small',
      price: { denom: 'umfx', amount: '1000' },
    });
    // Defensive: bail-out access to confirm the drops.
    const skuAsRecord = input?.sku as unknown as Record<string, unknown>;
    expect(skuAsRecord?.uuid).toBeUndefined();
    expect(skuAsRecord?.provider_uuid).toBeUndefined();
    expect(skuAsRecord?.active).toBeUndefined();
  });

  it('passes `sku: null` through unchanged', () => {
    const raw = fredResponse({ sku: null });
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.sku).toBeNull();
  });

  it('coerces a fred sku missing `price` to null (EvaluateReadinessInputs.sku requires price)', () => {
    // A non-active SKU or pre-pricing SKU may be returned without a
    // price by fred. The evaluator's `sku` shape REQUIRES `price: Coin`,
    // so the translator collapses price-less SKUs to `null` rather than
    // emitting an invalid object the evaluator would treat as truthy +
    // crash on `price.amount` access.
    const raw = fredResponse({
      sku: {
        name: 'small',
        uuid: 'u',
        provider_uuid: 'p',
        active: true,
        // no price
      } as unknown as CheckDeploymentReadinessResult['sku'],
    });
    evaluateReadinessFromFredResponse(raw, '1umfx', EMPTY_DENOM_MAP, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.sku).toBeNull();
  });
});

describe('evaluateReadinessFromFredResponse — context injection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the `tenantAddress` argument, IGNORING `raw.tenant`', () => {
    const raw = fredResponse({ tenant: 'manifest1fred' });
    evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1context',
    );
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.tenant).toBe('manifest1context');
    expect(input?.tenant).not.toBe('manifest1fred');
  });

  it('passes through `gasPrice` and `denomMap` from the deploy-app context', () => {
    const raw = fredResponse();
    const customMap = {
      lookup: (denom: string) =>
        denom === 'umfx' ? { symbol: 'MFX', exponent: 6 } : null,
      raw: null,
    };
    evaluateReadinessFromFredResponse(raw, '0.37upwr', customMap, 'tenant');
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.gasPrice).toBe('0.37upwr');
    expect(input?.denomMap).toBe(customMap);
  });
});

describe('evaluateReadinessFromFredResponse — smoke-integrated through evaluator', () => {
  // These don't mock the evaluator (the spy is set to call through actual);
  // they verify the translator wires into the real evaluator end-to-end.
  beforeEach(() => vi.clearAllMocks());

  it('returns status "ok" on the canonical happy-path fred response', () => {
    const raw = fredResponse();
    const out = evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1deadbeef',
    );
    expect(out.status).toBe('ok');
    expect(out.reasons).toEqual([]);
    expect(out.suggestedActions).toEqual([]);
  });

  it('returns status "block" when fred reports an empty wallet', () => {
    const raw = fredResponse({ wallet_balances: [] });
    const out = evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1deadbeef',
    );
    expect(out.status).toBe('block');
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.suggestedActions).toContain('request_faucet');
    expect(out.suggestedActions).toContain('topup_wallet');
  });

  it('returns status "block" when the requested SKU is not in available_sku_names', () => {
    const raw = fredResponse({ available_sku_names: ['medium'] });
    const out = evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1deadbeef',
    );
    expect(out.status).toBe('block');
    expect(out.suggestedActions).toContain('pick_different_sku');
  });
});
