import { toBase64, toUtf8 } from '@cosmjs/encoding';
import { describe, expect, it, vi } from 'vitest';
import {
  _adaptModule as adaptModule,
  _findConverter as findConverter,
  _patchWasmQueryData as patchWasmQueryData,
  _snakeToCamelDeep as snakeToCamelDeep,
  _unsupportedModule as unsupportedModule,
} from './lcd-adapter.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

describe('snakeToCamelDeep', () => {
  it('converts simple snake_case keys', () => {
    expect(
      snakeToCamelDeep({ provider_uuid: 'abc', lease_uuid: '123' }),
    ).toEqual({ providerUuid: 'abc', leaseUuid: '123' });
  });

  it('converts nested objects', () => {
    expect(snakeToCamelDeep({ outer_key: { inner_key: 'val' } })).toEqual({
      outerKey: { innerKey: 'val' },
    });
  });

  it('converts arrays of objects', () => {
    expect(snakeToCamelDeep([{ foo_bar: 1 }, { baz_qux: 2 }])).toEqual([
      { fooBar: 1 },
      { bazQux: 2 },
    ]);
  });

  it('passes through primitives', () => {
    expect(snakeToCamelDeep('hello')).toBe('hello');
    expect(snakeToCamelDeep(42)).toBe(42);
    expect(snakeToCamelDeep(true)).toBe(true);
    expect(snakeToCamelDeep(null)).toBe(null);
    expect(snakeToCamelDeep(undefined)).toBe(undefined);
  });

  it('passes through Date instances without recursing', () => {
    const d = new Date('2025-01-01');
    expect(snakeToCamelDeep(d)).toBe(d);
  });

  it('passes through Uint8Array instances without recursing', () => {
    const arr = new Uint8Array([1, 2, 3]);
    expect(snakeToCamelDeep(arr)).toBe(arr);
  });

  it('leaves already-camelCase keys unchanged', () => {
    expect(snakeToCamelDeep({ providerUuid: 'abc' })).toEqual({
      providerUuid: 'abc',
    });
  });

  it('handles empty objects', () => {
    expect(snakeToCamelDeep({})).toEqual({});
  });

  it('handles deeply nested structures', () => {
    expect(
      snakeToCamelDeep({
        credit_account: {
          balance: { amount: '100', denom: 'umfx' },
          tenant_address: 'manifest1abc',
        },
      }),
    ).toEqual({
      creditAccount: {
        balance: { amount: '100', denom: 'umfx' },
        tenantAddress: 'manifest1abc',
      },
    });
  });

  it('handles arrays nested inside objects', () => {
    expect(
      snakeToCamelDeep({
        lease_items: [
          { sku_uuid: 'a', item_count: 1 },
          { sku_uuid: 'b', item_count: 2 },
        ],
      }),
    ).toEqual({
      leaseItems: [
        { skuUuid: 'a', itemCount: 1 },
        { skuUuid: 'b', itemCount: 2 },
      ],
    });
  });

  it('handles keys with uppercase after underscore', () => {
    expect(snakeToCamelDeep({ status_OK: true })).toEqual({ statusOK: true });
  });

  it('handles keys with digits after underscore', () => {
    expect(snakeToCamelDeep({ v1beta1_balance: '100' })).toEqual({
      v1beta1Balance: '100',
    });
  });
});

describe('findConverter', () => {
  it('finds converter with Query prefix', () => {
    const ns = { QueryBalanceResponse: { fromJSON: vi.fn() } };
    const converter = findConverter(ns, 'balance');
    expect(converter).toBe(ns.QueryBalanceResponse);
  });

  it('falls back to plain name without Query prefix', () => {
    const ns = { BalanceResponse: { fromJSON: vi.fn() } };
    const converter = findConverter(ns, 'balance');
    expect(converter).toBe(ns.BalanceResponse);
  });

  it('prefers Query-prefixed form over plain', () => {
    const ns = {
      QueryBalanceResponse: { fromJSON: vi.fn() },
      BalanceResponse: { fromJSON: vi.fn() },
    };
    const converter = findConverter(ns, 'balance');
    expect(converter).toBe(ns.QueryBalanceResponse);
  });

  it('throws QUERY_FAILED when no converter exists', () => {
    expect(() => findConverter({}, 'nonexistent')).toThrow(ManifestMCPError);
    try {
      findConverter({}, 'nonexistent');
    } catch (e) {
      expect((e as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.QUERY_FAILED,
      );
      expect((e as ManifestMCPError).message).toContain(
        'No response converter found',
      );
    }
  });

  it('throws when converter exists but lacks fromJSON', () => {
    const ns = { QueryBalanceResponse: { toJSON: vi.fn() } };
    expect(() => findConverter(ns as any, 'balance')).toThrow(ManifestMCPError);
  });
});

describe('adaptModule', () => {
  it('wraps LCD methods with snakeToCamel and fromJSON conversion', async () => {
    const originalFn = vi
      .fn()
      .mockResolvedValue({ total_count: '5', some_data: 'raw' });
    const lcdModule = { myMethod: originalFn, req: {} };
    const converter = {
      fromJSON: vi.fn().mockReturnValue({ totalCount: 5, someData: 'raw' }),
    };
    const converterNamespace = { QueryMyMethodResponse: converter };

    const adapted = adaptModule(lcdModule, converterNamespace);

    expect(adapted.req).toBeUndefined();
    expect(adapted.myMethod).toBeDefined();

    const result = await adapted.myMethod('arg1');
    expect(originalFn).toHaveBeenCalledWith('arg1');
    expect(converter.fromJSON).toHaveBeenCalledWith({
      totalCount: '5',
      someData: 'raw',
    });
    expect(result).toEqual({ totalCount: 5, someData: 'raw' });
  });

  it('skips non-function properties', () => {
    const lcdModule = { myMethod: vi.fn(), someConfig: 'string-value' };
    const converterNamespace = { QueryMyMethodResponse: { fromJSON: vi.fn() } };
    const adapted = adaptModule(lcdModule, converterNamespace);
    expect(adapted.someConfig).toBeUndefined();
    expect(adapted.myMethod).toBeDefined();
  });

  it('wraps LCD errors in ManifestMCPError', async () => {
    const originalFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const lcdModule = { myMethod: originalFn };
    const converterNamespace = { QueryMyMethodResponse: { fromJSON: vi.fn() } };

    const adapted = adaptModule(lcdModule, converterNamespace);

    await expect(adapted.myMethod()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('LCD query "myMethod" failed'),
    });
  });

  it('wraps fromJSON errors in ManifestMCPError', async () => {
    const originalFn = vi.fn().mockResolvedValue({});
    const lcdModule = { myMethod: originalFn };
    const converterNamespace = {
      QueryMyMethodResponse: {
        fromJSON: () => {
          throw new Error('bad data');
        },
      },
    };

    const adapted = adaptModule(lcdModule, converterNamespace);

    await expect(adapted.myMethod()).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining(
        'Failed to convert LCD response for "myMethod"',
      ),
    });
  });
});

describe('patchWasmQueryData', () => {
  it.each([
    'smartContractState',
    'rawContractState',
  ] as const)('converts Uint8Array queryData to base64 for %s', async (method) => {
    const queryBytes = toUtf8(JSON.stringify({ config: {} }));
    const mockFn = vi.fn().mockResolvedValue({ data: 'result' });
    const patched = patchWasmQueryData({ [method]: mockFn, req: {} });

    await (patched[method] as (...args: never) => unknown)({
      address: 'manifest1abc',
      queryData: queryBytes,
    });

    expect(mockFn).toHaveBeenCalledWith({
      address: 'manifest1abc',
      queryData: toBase64(queryBytes),
    });
  });

  it('passes through non-Uint8Array queryData unchanged', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: 'result' });
    const patched = patchWasmQueryData({ smartContractState: mockFn, req: {} });

    await (patched.smartContractState as (...args: never) => unknown)({
      address: 'manifest1abc',
      queryData: 'already-base64',
    });

    expect(mockFn).toHaveBeenCalledWith({
      address: 'manifest1abc',
      queryData: 'already-base64',
    });
  });

  it('warns and skips methods that do not exist on the module', async () => {
    const { logger } = await import('./logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(() =>
      patchWasmQueryData({ otherMethod: vi.fn(), req: {} }),
    ).not.toThrow();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('smartContractState'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('rawContractState'),
    );
    warnSpy.mockRestore();
  });

  it('returns a new object without mutating the original', () => {
    const mockFn = vi.fn().mockResolvedValue({ data: 'result' });
    const wasmLcd = { smartContractState: mockFn, req: {} };
    const result = patchWasmQueryData(wasmLcd);

    expect(result).not.toBe(wasmLcd);
    expect(wasmLcd.smartContractState).toBe(mockFn);
    expect(result.smartContractState).not.toBe(mockFn);
  });
});

describe('unsupportedModule', () => {
  it('throws UNSUPPORTED_QUERY when any string property is accessed', () => {
    const proxy = unsupportedModule('cosmos.orm.query.v1alpha1');
    expect(() => (proxy as any).someMethod).toThrow(ManifestMCPError);
    try {
      (proxy as any).get;
    } catch (e) {
      expect((e as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.UNSUPPORTED_QUERY,
      );
      expect((e as ManifestMCPError).message).toContain(
        'not available via LCD/REST',
      );
    }
  });

  it('returns undefined for symbol property access', () => {
    const proxy = unsupportedModule('test.module');
    expect((proxy as any)[Symbol.toPrimitive]).toBeUndefined();
  });
});
