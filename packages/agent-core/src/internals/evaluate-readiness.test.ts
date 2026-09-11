import { asProviderUuid, asSkuUuid } from '@manifest-network/manifest-mcp-core';
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
  const sku =
    overrides.sku === undefined
      ? { name: 'docker-micro', price: { denom: 'umfx', amount: '100' } }
      : overrides.sku;
  return {
    leaseItems: sku
      ? [
          {
            kind: 'compute',
            quantity: 1,
            sku: {
              ...sku,
              skuUuid: asSkuUuid('sku-id'),
              providerUuid: asProviderUuid('provider-id'),
              active: true,
              billingUnit: 'hour',
            },
          },
        ]
      : [],
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
        /Credit account is empty for this deployment's MFX denom/.test(x),
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

  it('uses hoursRemaining fallback when no lease items are selected', () => {
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
      leaseItems: [],
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
      leaseItems: [],
      availableSkuNames: ['docker-micro'],
      skuCandidates: [{ name: 'docker-micro', providerUuid: 'p1' }],
      gasPrice: '1umfx',
    });
    // SKU gate not the blocker (credits-null only warns); status is not 'block' for SKU reasons.
    expect(r.reasons.join(' ')).not.toMatch(/is not currently offered/);
  });
});

describe('evaluateReadiness — gas-price formats', () => {
  it.each(['1umfx', '0.37upwr', '100umfx', '10.5umfx'])(
    'accepts gasPrice "%s"',
    (gp) => {
      expect(() =>
        evaluateReadiness(makeInputs({ gasPrice: gp })),
      ).not.toThrow();
    },
  );

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

describe('evaluateReadiness — exact deployment runway', () => {
  it.each(['hour', 'day'] as const)(
    'keeps the 24h boundary exact for large %s prices',
    (billingUnit) => {
      const price = 9007199254740993n;
      const threshold = billingUnit === 'day' ? price : price * 24n;
      for (const delta of [-1n, 0n, 1n]) {
        const inputs = makeInputs();
        inputs.leaseItems = inputs.leaseItems.map((item) => ({
          ...item,
          sku: {
            ...item.sku,
            billingUnit,
            price: { amount: price.toString(), denom: 'umfx' },
          },
        }));
        inputs.credits = {
          availableBalances: [
            { amount: (threshold + delta).toString(), denom: 'umfx' },
          ],
        };
        const result = evaluateReadiness(inputs);
        expect(result.status).toBe(delta < 0n ? 'warn' : 'ok');
      }
    },
  );

  it('warns using the known subtotal even when another item cannot be priced', () => {
    const inputs = makeInputs({
      credits: {
        availableBalances: [{ amount: '100', denom: 'umfx' }],
        hoursRemaining: '9999',
      },
    });
    inputs.leaseItems = [
      ...inputs.leaseItems,
      {
        ...inputs.leaseItems[0],
        kind: 'storage',
        sku: { ...inputs.leaseItems[0].sku, price: undefined },
      },
    ];
    const result = evaluateReadiness(inputs);
    expect(result.status).toBe('warn');
    expect(result.reasons).toEqual([
      expect.stringContaining('~1.0h of runtime'),
      expect.stringContaining('Cannot fully estimate deployment runtime'),
    ]);
    expect(result.suggestedActions).toContain('fund_credit');
  });

  it('warns for the limiting denomination after normalizing mixed periods', () => {
    const inputs = makeInputs({
      credits: {
        availableBalances: [
          { amount: '10000', denom: 'umfx' },
          { amount: '48', denom: 'upwr' },
        ],
      },
    });
    inputs.leaseItems = [
      ...inputs.leaseItems,
      {
        ...inputs.leaseItems[0],
        kind: 'storage',
        sku: {
          ...inputs.leaseItems[0].sku,
          billingUnit: 'day',
          price: { amount: '96', denom: 'upwr' },
        },
      },
    ];
    const result = evaluateReadiness(inputs);
    expect(result.status).toBe('warn');
    expect(result.reasons).toEqual([
      expect.stringContaining('~12.0h of runtime'),
    ]);
    expect(result.reasons[0]).toContain('0.000096 PWR per day');
  });

  it('does not require credits in the denomination of a free item', () => {
    const inputs = makeInputs({ credits: { availableBalances: [] } });
    inputs.leaseItems = inputs.leaseItems.map((item) => ({
      ...item,
      sku: { ...item.sku, price: { amount: '0', denom: 'upwr' } },
    }));
    expect(evaluateReadiness(inputs).status).toBe('ok');
  });
});
