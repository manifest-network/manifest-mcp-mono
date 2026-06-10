import { describe, expect, it } from 'vitest';
import type { Coin } from '../types.js';
import {
  type EvaluateReadinessInputs,
  evaluateReadiness,
} from './evaluate-readiness.js';
import type { DenomMap } from './humanize-denom.js';

const knownMap: DenomMap = {
  lookup: (denom) =>
    denom === 'umfx'
      ? { symbol: 'MFX', exponent: 6 }
      : denom === 'upwr'
        ? { symbol: 'PWR', exponent: 6 }
        : null,
  raw: null,
};

function makeInputs(
  overrides: Partial<EvaluateReadinessInputs> = {},
): EvaluateReadinessInputs {
  return {
    tenant: 'manifest1xxx',
    image: 'nginx:1.27',
    size: 'docker-micro',
    walletBalances: [{ denom: 'umfx', amount: '1000000' }],
    credits: {
      availableBalances: [{ denom: 'umfx', amount: '10000000' }],
    },
    sku: { name: 'docker-micro', price: { denom: 'umfx', amount: '100' } },
    availableSkuNames: ['docker-micro', 'docker-small'],
    gasPrice: '1umfx',
    denomMap: knownMap,
    ...overrides,
  };
}

describe('evaluateReadiness — happy path', () => {
  it('returns status: ok with no reasons / no actions when everything is fine', () => {
    const r = evaluateReadiness(makeInputs());
    expect(r.status).toBe('ok');
    expect(r.reasons).toEqual([]);
    expect(r.suggestedActions).toEqual([]);
  });

  it('carries walletBalances + sku through to output verbatim', () => {
    const inputs = makeInputs();
    const r = evaluateReadiness(inputs);
    expect(r.walletBalances).toBe(inputs.walletBalances);
    expect(r.sku).toBe(inputs.sku);
  });
});

describe('evaluateReadiness — SKU availability (block)', () => {
  it('blocks when requested size is not in availableSkuNames', () => {
    const r = evaluateReadiness(
      makeInputs({
        size: 'docker-huge',
        availableSkuNames: ['docker-micro', 'docker-small'],
      }),
    );
    expect(r.status).toBe('block');
    expect(r.reasons[0]).toMatch(/"docker-huge" is not currently offered/);
    expect(r.suggestedActions).toContain('pick_different_sku');
  });

  it('handles empty availableSkuNames with "(none)" label', () => {
    const r = evaluateReadiness(
      makeInputs({ size: 'anything', availableSkuNames: [] }),
    );
    expect(r.reasons[0]).toMatch(/Available: \(none\)/);
  });
});

describe('evaluateReadiness — wallet gas balance', () => {
  it('blocks when wallet has empty balances', () => {
    const r = evaluateReadiness(makeInputs({ walletBalances: [] }));
    expect(r.status).toBe('block');
    expect(r.reasons.some((x) => x.includes('no MFX balance for gas'))).toBe(
      true,
    );
    expect(r.suggestedActions).toEqual(
      expect.arrayContaining(['request_faucet', 'topup_wallet']),
    );
  });

  it('blocks when wallet has no entry in gas denom', () => {
    const r = evaluateReadiness(
      makeInputs({ walletBalances: [{ denom: 'upwr', amount: '1000000' }] }),
    );
    expect(r.status).toBe('block');
    expect(r.reasons.some((x) => x.includes('no MFX balance'))).toBe(true);
  });

  it('warns when gas balance is below the warn floor', () => {
    const r = evaluateReadiness(
      makeInputs({ walletBalances: [{ denom: 'umfx', amount: '100' }] }), // 100 < 50_000
    );
    expect(r.status).toBe('warn');
    expect(r.reasons[0]).toMatch(/below/);
    expect(r.suggestedActions).toContain('topup_wallet');
  });

  it('passes when gas balance is at or above warn floor', () => {
    const r = evaluateReadiness(
      makeInputs({ walletBalances: [{ denom: 'umfx', amount: '50000' }] }),
    );
    // Still 'ok' because we have a credit account too.
    expect(r.status).toBe('ok');
  });

  it('respects explicit gasWarnFloor override', () => {
    const r = evaluateReadiness(
      makeInputs({
        walletBalances: [{ denom: 'umfx', amount: '40000' }],
        gasWarnFloor: 100_000n, // higher than default 50_000
      }),
    );
    expect(r.status).toBe('warn');
  });

  it('uses per-denom fallback floor for unknown gas denoms', () => {
    const r = evaluateReadiness(
      makeInputs({
        gasPrice: '1ufoo',
        walletBalances: [{ denom: 'ufoo', amount: '100' }],
      }),
    );
    expect(r.status).toBe('warn'); // 100 < fallback 50_000
  });

  it('throws TypeError on malformed gasPrice', () => {
    expect(() => evaluateReadiness(makeInputs({ gasPrice: '' }))).toThrow(
      /gasPrice must match/,
    );
    expect(() => evaluateReadiness(makeInputs({ gasPrice: 'umfx' }))).toThrow();
    expect(() =>
      evaluateReadiness(
        makeInputs({ gasPrice: '1umfx ' /* trailing space */ }),
      ),
    ).toThrow();
  });

  it('throws TypeError on negative gasWarnFloor', () => {
    expect(() => evaluateReadiness(makeInputs({ gasWarnFloor: -1n }))).toThrow(
      /non-negative integer/,
    );
  });
});

describe('evaluateReadiness — credits', () => {
  it('warns when credits is null (no credit account)', () => {
    const r = evaluateReadiness(makeInputs({ credits: null }));
    expect(r.status).toBe('warn');
    expect(r.reasons.some((x) => x.includes('No credit account funded'))).toBe(
      true,
    );
    expect(r.suggestedActions).toContain('fund_credit');
  });

  it('warns when credit account has no entry in SKU denom (different denom funded)', () => {
    const r = evaluateReadiness(
      makeInputs({
        sku: { name: 'docker-micro', price: { denom: 'umfx', amount: '100' } },
        credits: {
          availableBalances: [{ denom: 'upwr', amount: '1000000' }],
        },
      }),
    );
    expect(r.status).toBe('warn');
    expect(
      r.reasons.some((x) => /Credit account has no MFX balance/.test(x)),
    ).toBe(true);
    expect(r.suggestedActions).toContain('fund_credit');
  });

  it('warns when credit account is empty (no funded denoms at all)', () => {
    const r = evaluateReadiness(
      makeInputs({
        credits: { availableBalances: [] },
      }),
    );
    expect(r.status).toBe('warn');
    expect(
      r.reasons.some((x) =>
        /Credit account is empty for the .* SKU's MFX denom/.test(x),
      ),
    ).toBe(true);
  });

  it('warns when credits cover less than 24h at the chosen SKU', () => {
    // 1000 umfx / 100 umfx-per-hour = 10h (below 24h floor)
    const r = evaluateReadiness(
      makeInputs({
        credits: {
          availableBalances: [{ denom: 'umfx', amount: '1000' }],
        },
        sku: { name: 'docker-micro', price: { denom: 'umfx', amount: '100' } },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.reasons.some((x) => /~10\.0h of runtime/.test(x))).toBe(true);
    expect(r.suggestedActions).toContain('fund_credit');
  });

  it('passes when credits cover >24h', () => {
    // 10_000_000 / 100 = 100_000h
    const r = evaluateReadiness(
      makeInputs({
        credits: {
          availableBalances: [{ denom: 'umfx', amount: '10000000' }],
        },
        sku: { name: 'docker-micro', price: { denom: 'umfx', amount: '100' } },
      }),
    );
    expect(r.status).toBe('ok');
  });

  it('falls back from availableBalances → balances → currentBalance', () => {
    const r = evaluateReadiness(
      makeInputs({
        credits: {
          // availableBalances absent
          balances: [{ denom: 'umfx', amount: '500' }], // fallback level 1
        },
      }),
    );
    expect(r.status).toBe('warn'); // 500/100 = 5h < 24h
  });

  it('uses hoursRemaining fallback when SKU pricing is unavailable', () => {
    const r = evaluateReadiness(
      makeInputs({
        sku: null,
        credits: {
          availableBalances: [{ denom: 'umfx', amount: '500' }],
          hoursRemaining: '5',
        },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.reasons.some((x) => /~5\.0h.*current burn rate/.test(x))).toBe(
      true,
    );
  });

  it('hoursRemaining === "0" does NOT trigger warn (no active leases, not low credits)', () => {
    const r = evaluateReadiness(
      makeInputs({
        sku: null,
        credits: {
          availableBalances: [{ denom: 'umfx', amount: '500' }],
          hoursRemaining: '0',
        },
      }),
    );
    // 0 means "no current burn" per CJS comment, not "low credits"
    expect(r.reasons.some((x) => /current burn rate/.test(x))).toBe(false);
  });

  it('Readiness.credits.availableBalances pass-through includes the fallback chain', () => {
    const r = evaluateReadiness(
      makeInputs({
        credits: {
          balances: [{ denom: 'umfx', amount: '500' }] as Coin[],
        },
      }),
    );
    expect(r.credits?.availableBalances).toEqual([
      { denom: 'umfx', amount: '500' },
    ]);
  });
});

describe('evaluateReadiness — multi-issue combinations', () => {
  it('block + warn combined: SKU-block dominates status', () => {
    const r = evaluateReadiness(
      makeInputs({
        size: 'docker-huge',
        availableSkuNames: ['docker-micro'],
        walletBalances: [{ denom: 'umfx', amount: '1000' }], // also low
      }),
    );
    expect(r.status).toBe('block');
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
    expect(r.suggestedActions).toEqual(
      expect.arrayContaining(['pick_different_sku', 'topup_wallet']),
    );
  });

  it('multiple warns combined: status stays warn', () => {
    const r = evaluateReadiness(
      makeInputs({
        walletBalances: [{ denom: 'umfx', amount: '1000' }], // warn
        credits: null, // warn
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.suggestedActions).toEqual(
      expect.arrayContaining(['topup_wallet', 'fund_credit']),
    );
  });
});

describe('evaluateReadiness — ENG-258 skuCandidates gate', () => {
  it('ENG-258: blocks when no candidate matches the requested provider', () => {
    const r = evaluateReadiness({
      tenant: 't',
      image: null,
      size: 'docker-micro',
      walletBalances: [{ denom: 'umfx', amount: '100000' }],
      credits: null,
      sku: null,
      availableSkuNames: ['docker-micro'],
      skuCandidates: [{ name: 'docker-micro', providerUuid: 'p1' }],
      requestedProviderUuid: 'p2',
      gasPrice: '1umfx',
    });
    expect(r.status).toBe('block');
    expect(r.reasons.join(' ')).toMatch(/p2|provider/);
  });

  it('ENG-258: passes the SKU gate when a candidate matches', () => {
    const r = evaluateReadiness({
      tenant: 't',
      image: null,
      size: 'docker-micro',
      walletBalances: [{ denom: 'umfx', amount: '100000' }],
      credits: null,
      sku: null,
      availableSkuNames: ['docker-micro'],
      skuCandidates: [{ name: 'docker-micro', providerUuid: 'p1' }],
      gasPrice: '1umfx',
    });
    // SKU gate not the blocker (credits-null only warns); status is not 'block' for SKU reasons.
    expect(r.reasons.join(' ')).not.toMatch(/is not currently offered/);
  });
});

describe('evaluateReadiness — gas-price formats', () => {
  it.each([
    '1umfx',
    '0.37upwr',
    '100umfx',
    '10.5umfx',
  ])('accepts gasPrice "%s"', (gp) => {
    expect(() => evaluateReadiness(makeInputs({ gasPrice: gp }))).not.toThrow();
  });

  it('uses the gasPrice denom to find the wallet entry', () => {
    // gas in upwr, but wallet only has umfx → block (no upwr balance)
    const r = evaluateReadiness(
      makeInputs({
        gasPrice: '0.37upwr',
        walletBalances: [{ denom: 'umfx', amount: '1000000' }],
      }),
    );
    expect(r.status).toBe('block');
    expect(r.reasons.some((x) => x.includes('no PWR balance'))).toBe(true);
  });
});
