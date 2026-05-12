import { describe, expect, it } from 'vitest';
import type { DenomMap } from './humanize-denom.js';
import { humanizeFee } from './humanize-fee.js';

const knownMap: DenomMap = {
  lookup: (denom) =>
    denom === 'umfx'
      ? { symbol: 'MFX', exponent: 6 }
      : denom === 'upwr'
        ? { symbol: 'PWR', exponent: 6 }
        : null,
  raw: null,
};

describe('humanizeFee', () => {
  it('renders a single-coin fee with a known denom (scaled + symbol)', () => {
    const result = humanizeFee(
      { gasUsed: 142000, amount: [{ denom: 'umfx', amount: '2300' }] },
      { denomMap: knownMap },
    );
    expect(result).toEqual({
      amount: '0.0023 MFX',
      denom: 'umfx',
      gas: 142000,
      human: '0.0023 MFX',
    });
  });

  it('renders a multi-coin fee — human joins with ", "; singular fields carry first coin', () => {
    const result = humanizeFee(
      {
        gasUsed: 200000,
        amount: [
          { denom: 'umfx', amount: '2300' },
          { denom: 'upwr', amount: '100' },
        ],
      },
      { denomMap: knownMap },
    );
    expect(result.human).toBe('0.0023 MFX, 0.0001 PWR');
    expect(result.amount).toBe('0.0023 MFX');
    expect(result.denom).toBe('umfx');
    expect(result.gas).toBe(200000);
  });

  it('returns "(empty)" human + "0" amount + "" denom for empty fee array', () => {
    const result = humanizeFee(
      { gasUsed: 0, amount: [] },
      { denomMap: knownMap },
    );
    expect(result).toEqual({
      amount: '0',
      denom: '',
      gas: 0,
      human: '(empty)',
    });
  });

  it('falls back to raw denom rendering when no denomMap is provided', () => {
    const result = humanizeFee({
      gasUsed: 100,
      amount: [{ denom: 'umfx', amount: '500' }],
    });
    // No chainDataFile, no denomMap → no-op DenomMap → raw rendering.
    expect(result.human).toBe('500 umfx');
    expect(result.amount).toBe('500 umfx');
    expect(result.denom).toBe('umfx');
  });

  it('renders unknown denoms verbatim alongside known ones', () => {
    const result = humanizeFee(
      {
        gasUsed: 150,
        amount: [
          { denom: 'umfx', amount: '1000' },
          { denom: 'factory/manifest1xxx/upwr', amount: '50' },
        ],
      },
      { denomMap: knownMap },
    );
    expect(result.human).toBe('0.001 MFX, 50 factory/manifest1xxx/upwr');
    // Singular fields carry the first coin (known umfx).
    expect(result.amount).toBe('0.001 MFX');
    expect(result.denom).toBe('umfx');
  });

  it('explicit denomMap wins over chainDataFile when both supplied', () => {
    // Provide both: denomMap with custom symbol, chainDataFile pointing nowhere.
    // The denomMap must win — no read attempt, no warn.
    const customMap: DenomMap = {
      lookup: () => ({ symbol: 'CUSTOM', exponent: 0 }),
      raw: null,
    };
    const result = humanizeFee(
      { gasUsed: 1, amount: [{ denom: 'whatever', amount: '5' }] },
      { denomMap: customMap, chainDataFile: '/does/not/exist.json' },
    );
    expect(result.human).toBe('5 CUSTOM');
  });

  it('preserves gasUsed verbatim in the gas field', () => {
    expect(
      humanizeFee(
        { gasUsed: 1_234_567, amount: [{ denom: 'umfx', amount: '0' }] },
        { denomMap: knownMap },
      ).gas,
    ).toBe(1_234_567);
  });
});
