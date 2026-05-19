import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _fmtScaledAmount,
  type DenomMap,
  denomToSymbol,
  humanizeBalances,
  humanizeCoin,
  loadChainDenomMap,
} from './humanize-denom.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'humanize-denom-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeChainRegistry(file: string, content: object): string {
  const path = join(tmp, file);
  writeFileSync(path, JSON.stringify(content), 'utf8');
  return path;
}

describe('loadChainDenomMap', () => {
  it('returns the no-op map when no path is supplied', async () => {
    const map = await loadChainDenomMap();
    expect(map.lookup('umfx')).toBeNull();
    expect(map.raw).toBeNull();
  });

  it('returns the no-op map when path is empty string', async () => {
    const map = await loadChainDenomMap('');
    expect(map.lookup('umfx')).toBeNull();
    expect(map.raw).toBeNull();
  });

  it('returns the no-op map + warns when the file is unreadable', async () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const missing = join(tmp, 'does-not-exist.json');
      const map = await loadChainDenomMap(missing);
      expect(map.lookup('umfx')).toBeNull();
      expect(map.raw).toBeNull();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(
        /humanize-denom: failed to load/,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns the no-op map + warns when JSON is malformed', async () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const path = join(tmp, 'broken.json');
      writeFileSync(path, '{not valid json', 'utf8');
      const map = await loadChainDenomMap(path);
      expect(map.lookup('umfx')).toBeNull();
      expect(warnSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('parses a feeTokens[] map and resolves denom → {symbol, exponent: 6}', async () => {
    const path = writeChainRegistry('testnet.json', {
      feeTokens: [
        { denom: 'umfx', symbol: 'MFX' },
        { denom: 'factory/manifest1xxx/upwr', symbol: 'PWR' },
      ],
    });
    const map = await loadChainDenomMap(path);
    expect(map.lookup('umfx')).toEqual({ symbol: 'MFX', exponent: 6 });
    expect(map.lookup('factory/manifest1xxx/upwr')).toEqual({
      symbol: 'PWR',
      exponent: 6,
    });
    expect(map.lookup('unknown_denom')).toBeNull();
  });

  it('ignores malformed feeTokens entries (non-object, missing fields)', async () => {
    const path = writeChainRegistry('mixed.json', {
      feeTokens: [
        { denom: 'umfx', symbol: 'MFX' },
        null,
        { denom: 'no-symbol' },
        { symbol: 'no-denom' },
        'string-element',
        { denom: 42, symbol: 'wrong-type' },
      ],
    });
    const map = await loadChainDenomMap(path);
    expect(map.lookup('umfx')).toEqual({ symbol: 'MFX', exponent: 6 });
    expect(map.lookup('no-symbol')).toBeNull();
    expect(map.lookup('no-denom')).toBeNull();
  });

  it('returns the raw chain JSON for callers that need it', async () => {
    const content = {
      feeTokens: [{ denom: 'umfx', symbol: 'MFX' }],
      extra: 'kept',
    };
    const path = writeChainRegistry('with-extra.json', content);
    const map = await loadChainDenomMap(path);
    expect(map.raw).toEqual(content);
  });

  it('handles JSON without feeTokens gracefully (lookup returns null)', async () => {
    const path = writeChainRegistry('no-fee-tokens.json', { other: 'data' });
    const map = await loadChainDenomMap(path);
    expect(map.lookup('umfx')).toBeNull();
    expect(map.raw).toEqual({ other: 'data' });
  });

  it('lookup returns null for non-string input (type guard)', async () => {
    const path = writeChainRegistry('any.json', {
      feeTokens: [{ denom: 'umfx', symbol: 'MFX' }],
    });
    const map = await loadChainDenomMap(path);
    expect(map.lookup(42 as unknown as string)).toBeNull();
    expect(map.lookup(null as unknown as string)).toBeNull();
  });
});

describe('_fmtScaledAmount', () => {
  it.each<[string, number, string]>([
    ['1000000', 6, '1'],
    ['1800000', 6, '1.8'],
    ['57738', 6, '0.057738'],
    ['1', 6, '0.000001'],
    ['0', 6, '0'],
    ['1234567', 6, '1.234567'],
    ['1230000', 6, '1.23'],
  ])('scales %s with exponent %i → %s', (input, exp, expected) => {
    expect(_fmtScaledAmount(input, exp)).toBe(expected);
  });

  it('handles negative amounts', () => {
    expect(_fmtScaledAmount('-1800000', 6)).toBe('-1.8');
  });

  it('preserves large precision via BigInt', () => {
    expect(_fmtScaledAmount('123456789012345678901', 6)).toBe(
      '123456789012345.678901',
    );
  });

  it('falls back to String() on non-numeric input', () => {
    expect(_fmtScaledAmount('not-a-number', 6)).toBe('not-a-number');
  });
});

describe('humanizeCoin', () => {
  const denomMap: DenomMap = {
    lookup: (denom) =>
      denom === 'umfx' ? { symbol: 'MFX', exponent: 6 } : null,
    raw: null,
  };

  it('renders known denom with scaled amount + symbol', () => {
    expect(humanizeCoin('1800000', 'umfx', denomMap)).toBe('1.8 MFX');
  });

  it('renders unknown denom verbatim with raw amount (no scaling)', () => {
    expect(humanizeCoin('37', 'upwr', denomMap)).toBe('37 upwr');
  });

  it('returns amount alone when denom is null or undefined', () => {
    expect(humanizeCoin('100', null, denomMap)).toBe('100');
    expect(humanizeCoin('100', undefined, denomMap)).toBe('100');
  });
});

describe('humanizeBalances', () => {
  const denomMap: DenomMap = {
    lookup: (denom) =>
      denom === 'umfx' ? { symbol: 'MFX', exponent: 6 } : null,
    raw: null,
  };

  it('returns "(empty)" literal for an empty array', () => {
    expect(humanizeBalances([], denomMap)).toBe('(empty)');
  });

  it('returns "(empty)" literal for non-array input', () => {
    expect(humanizeBalances(null, denomMap)).toBe('(empty)');
    expect(humanizeBalances(undefined, denomMap)).toBe('(empty)');
    expect(humanizeBalances('not an array', denomMap)).toBe('(empty)');
  });

  it('renders a single coin', () => {
    expect(
      humanizeBalances([{ denom: 'umfx', amount: '1800000' }], denomMap),
    ).toBe('1.8 MFX');
  });

  it('joins multiple coins with ", " (space after comma)', () => {
    expect(
      humanizeBalances(
        [
          { denom: 'umfx', amount: '1800000' },
          { denom: 'upwr', amount: '100' },
        ],
        denomMap,
      ),
    ).toBe('1.8 MFX, 100 upwr');
  });

  it('handles missing amount field with "0" fallback', () => {
    expect(
      humanizeBalances([{ denom: 'umfx' } as { denom: string }], denomMap),
    ).toBe('0 MFX');
  });
});

describe('denomToSymbol', () => {
  const denomMap: DenomMap = {
    lookup: (denom) =>
      denom === 'umfx' ? { symbol: 'MFX', exponent: 6 } : null,
    raw: null,
  };

  it('returns the friendly symbol for a known denom', () => {
    expect(denomToSymbol('umfx', denomMap)).toBe('MFX');
  });

  it('returns the raw denom verbatim for unknown', () => {
    expect(denomToSymbol('factory/.../upwr', denomMap)).toBe(
      'factory/.../upwr',
    );
  });

  it('returns "" for null/undefined denom', () => {
    expect(denomToSymbol(null, denomMap)).toBe('');
    expect(denomToSymbol(undefined, denomMap)).toBe('');
  });
});
