import type { CheckDeploymentReadinessResult } from '@manifest-network/manifest-mcp-fred';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as evalMod from './evaluate-readiness.js';
import { evaluateReadinessFromFredResponse } from './evaluate-readiness-from-fred.js';
import { EMPTY_DENOM_MAP } from './humanize-denom.js';

// ENG-185 sub-PR B item 1 — translator from fred's snake_case wire shape
// (`CheckDeploymentReadinessResult`) to the canonical `evaluateReadiness`'s
// camelCase `EvaluateReadinessInputs`. The translator MUST:
//
//   - Rename `wallet_balances` → `walletBalances`; derive `availableSkuNames`
//     from `available_skus` (ENG-258 clean-break: `available_sku_names` was
//     removed); map `sku_candidates` → `skuCandidates`.
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
    sku_candidates: [
      {
        name: 'small',
        uuid: 'sku-uuid-fixture',
        provider_uuid: 'prov-uuid-fixture',
        price: { denom: 'umfx', amount: '1000' },
        active: true,
      },
    ],
    available_skus: [
      {
        name: 'small',
        uuid: 'sku-uuid-fixture',
        provider_uuid: 'prov-uuid-fixture',
      },
      {
        name: 'medium',
        uuid: 'sku-uuid-medium',
        provider_uuid: 'prov-uuid-fixture',
      },
    ],
    ready: true,
    missing_steps: [],
    ...overrides,
  } as CheckDeploymentReadinessResult;
}

describe('evaluateReadinessFromFredResponse — field mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renames the top-level snake_case fields to camelCase; derives availableSkuNames from available_skus', () => {
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
    // availableSkuNames is now derived from available_skus (ENG-258 clean-break).
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

  it('returns status "block" when the requested SKU is not in available_skus AND fred did not resolve it', () => {
    // `raw.sku === null` mirrors fred's behavior when the requested
    // `size` is genuinely not offered (no matching active SKU). With
    // the ENG-258 candidate-based gate, `available_skus` is now the
    // source of truth. This test requires BOTH the skus list to omit
    // `size` AND fred to have failed resolution (`sku: null`, empty
    // `sku_candidates`) to verify the SKU-availability rule still fires
    // when the SKU is truly absent.
    const raw = fredResponse({
      size: 'small',
      available_skus: [
        { name: 'medium', uuid: 'sku-medium', provider_uuid: 'p1' },
      ],
      sku_candidates: [],
      sku: null,
    });
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

describe('evaluateReadinessFromFredResponse — ENG-258 sku_candidates forwarding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ENG-258: forwards sku_candidates and derives availableSkuNames from available_skus', () => {
    const raw = {
      tenant: 't',
      image: null,
      size: 'docker-micro',
      wallet_balances: [{ denom: 'umfx', amount: '100000' }],
      credits: null,
      sku: null,
      sku_candidates: [
        {
          name: 'docker-micro',
          uuid: 'a',
          provider_uuid: 'p1',
          price: { amount: '100', denom: 'umfx' },
          active: true,
        },
      ],
      available_skus: [
        { name: 'docker-micro', uuid: 'a', provider_uuid: 'p1' },
      ],
      ready: true,
      missing_steps: [],
    } as never;
    const r = evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      't',
    );
    // SKU gate passes because a candidate matches (not because of a name list).
    expect(r.reasons.join(' ')).not.toMatch(/not currently offered/);
  });
});

describe('evaluateReadinessFromFredResponse — FIX-1 end-to-end gate (ENG-258 r2)', () => {
  // Real translator + real evaluateReadiness (spy calls through to actual).
  // No mocks of the evaluator logic — this guards the invariant that
  // `size: pinned.name` (the RESOLVED on-chain name) passes the
  // `skuCandidates.some(c => c.name === size)` gate, while a mismatched
  // `size` (the old behavior: raw user request that doesn't match the
  // resolved candidate name) would block.

  beforeEach(() => vi.clearAllMocks());

  it('FIX-1 POSITIVE: resolved name matches candidate → SKU gate passes (status !== block for SKU rule)', () => {
    // Fred-shaped response where `size` equals the resolved SKU's `name`
    // (the post-fix behavior: deploy-app threads `pinned.name`).
    // Wallet and credits are valid so other rules don't interfere.
    const raw = {
      tenant: 'manifest1deadbeef',
      image: 'docker.io/library/nginx:1.27',
      size: 'docker-micro', // RESOLVED name — matches the candidate below
      wallet_balances: [{ denom: 'umfx', amount: '10000000' }],
      credits: {
        active_leases: '0',
        pending_leases: '0',
        reserved_amounts: [],
        available_balances: [{ denom: 'umfx', amount: '50000000000' }],
      },
      sku: {
        name: 'docker-micro',
        uuid: 'X',
        provider_uuid: 'p1',
        price: { denom: 'umfx', amount: '1' },
        active: true,
      },
      sku_candidates: [
        {
          name: 'docker-micro',
          uuid: 'X',
          provider_uuid: 'p1',
          price: { amount: '1', denom: 'umfx' },
          active: true,
        },
      ],
      available_skus: [
        { name: 'docker-micro', uuid: 'X', provider_uuid: 'p1' },
      ],
      ready: true,
      missing_steps: [],
    } as never;

    const out = evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1deadbeef',
    );

    // The SKU gate must NOT have fired — resolved name matches candidate.
    expect(out.reasons.some((r) => /not currently offered/i.test(r))).toBe(
      false,
    );
    expect(out.suggestedActions).not.toContain('pick_different_sku');
    // Overall status is ok (wallet + credits are healthy).
    expect(out.status).toBe('ok');
  });

  it('FIX-1 NEGATIVE: mismatched size does NOT match candidate → SKU gate blocks (proves gate is real and fix is load-bearing)', () => {
    // Same sku_candidates as above, but `size: 'small'` — the raw user
    // request that does NOT match the candidate's name ('docker-micro').
    // This is exactly the old (pre-fix) behavior when deploy-app passed
    // `requestedSize(spec)` instead of `pinned.name`. The gate must fire.
    const raw = {
      tenant: 'manifest1deadbeef',
      image: 'docker.io/library/nginx:1.27',
      size: 'small', // MISMATCHED — does not match 'docker-micro' candidate
      wallet_balances: [{ denom: 'umfx', amount: '10000000' }],
      credits: {
        active_leases: '0',
        pending_leases: '0',
        reserved_amounts: [],
        available_balances: [{ denom: 'umfx', amount: '50000000000' }],
      },
      sku: null, // no resolved sku for the mismatched size
      sku_candidates: [
        {
          name: 'docker-micro',
          uuid: 'X',
          provider_uuid: 'p1',
          price: { amount: '1', denom: 'umfx' },
          active: true,
        },
      ],
      available_skus: [
        { name: 'docker-micro', uuid: 'X', provider_uuid: 'p1' },
      ],
      ready: false,
      missing_steps: [],
    } as never;

    const out = evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1deadbeef',
    );

    // The SKU gate must have fired — 'small' is not in the candidate list.
    expect(out.status).toBe('block');
    expect(out.reasons.some((r) => /not currently offered/i.test(r))).toBe(
      true,
    );
    expect(out.suggestedActions).toContain('pick_different_sku');
  });
});

describe('evaluateReadinessFromFredResponse — sku-name union (Copilot #3319670583)', () => {
  // Fred caps `available_skus` at MAX_SKU_NAMES_RETURNED = 50
  // (`packages/fred/src/tools/checkDeploymentReadiness.ts`). When fred
  // offers >50 SKUs and the user's requested size is past the slice
  // boundary, the evaluator's SKU-availability rule could false-block a
  // valid deploy. Fred ALREADY resolved the user's requested SKU (it's
  // on `raw.sku.name`), so the translator unions that name into the
  // names set before handing off to the evaluator.
  // Note: `available_sku_names` was removed in ENG-258 Task 15
  // (clean-break); the source of truth is now `available_skus`.

  beforeEach(() => vi.clearAllMocks());

  it('unions `raw.sku.name` into `availableSkuNames` so a fred-resolved SKU past the 50-name slice does not false-block', () => {
    // Simulate the truncation: 'docker-xxlarge' is OFFERED by fred (it
    // resolved `raw.sku` with that name), but the `available_skus`
    // display list omits it (would have if real fred truncated past
    // entry 50). Without the union the evaluator's SKU rule fires
    // `status: 'block'` with "Requested SKU ... not currently offered";
    // with the union the rule passes silently.
    const raw = fredResponse({
      size: 'docker-xxlarge',
      sku: {
        name: 'docker-xxlarge',
        uuid: 'sku-uuid-xxlarge',
        provider_uuid: 'prov-uuid-xxlarge',
        active: true,
        price: { denom: 'umfx', amount: '100' },
      },
      sku_candidates: [
        {
          name: 'docker-xxlarge',
          uuid: 'sku-uuid-xxlarge',
          provider_uuid: 'prov-uuid-xxlarge',
          active: true,
          price: { denom: 'umfx', amount: '100' },
        },
      ],
      available_skus: [
        { name: 'docker-micro', uuid: 'sku-micro', provider_uuid: 'p1' },
        { name: 'docker-small', uuid: 'sku-small', provider_uuid: 'p1' },
        // 'docker-xxlarge' deliberately absent to simulate truncation
      ],
    });
    const out = evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1deadbeef',
    );
    // The SKU-availability rule must NOT have fired —
    // candidates path found a match for 'docker-xxlarge'.
    expect(
      out.reasons.some((r) =>
        /Requested SKU.*is not currently offered/i.test(r),
      ),
    ).toBe(false);
    expect(out.suggestedActions).not.toContain('pick_different_sku');
    // The rest of the canonical happy-path values are unchanged
    // (wallet, credits, sku price), so the overall verdict is 'ok'.
    expect(out.status).toBe('ok');
  });

  it('union via Set dedupes — when `raw.sku.name` is ALREADY in `available_skus`, no double-add', () => {
    const raw = fredResponse({
      // `'small'` appears in BOTH `available_skus` and `raw.sku.name`.
      // The Set-backed union must dedupe — no double entry would mask a
      // future bug where the size check compares lengths.
      available_skus: [
        {
          name: 'small',
          uuid: 'sku-uuid-fixture',
          provider_uuid: 'prov-uuid-fixture',
        },
        {
          name: 'medium',
          uuid: 'sku-uuid-medium',
          provider_uuid: 'prov-uuid-fixture',
        },
      ],
    });
    evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1deadbeef',
    );
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.availableSkuNames).toEqual(['small', 'medium']);
    expect(input?.availableSkuNames).toHaveLength(2);
  });

  it('no-op when `raw.sku === null` — does not add or crash', () => {
    const raw = fredResponse({
      sku: null,
      sku_candidates: [],
      available_skus: [
        {
          name: 'small',
          uuid: 'sku-uuid-fixture',
          provider_uuid: 'prov-uuid-fixture',
        },
        {
          name: 'medium',
          uuid: 'sku-uuid-medium',
          provider_uuid: 'prov-uuid-fixture',
        },
      ],
    });
    evaluateReadinessFromFredResponse(
      raw,
      '1umfx',
      EMPTY_DENOM_MAP,
      'manifest1deadbeef',
    );
    const input = vi.mocked(evalMod.evaluateReadiness).mock.calls[0]?.[0];
    expect(input?.availableSkuNames).toEqual(['small', 'medium']);
  });
});
