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

describe('adaptModule error classification (ENG-536)', () => {
  function axiosError(status: number, data: unknown): Error {
    const err = new Error(`Request failed with status code ${status}`);
    Object.assign(err, { response: { status, data } });
    return err;
  }

  // The shape no pre-ENG-536 test used — which is exactly why the bug shipped.
  it('mints NOT_FOUND from a real LCD 404 grpc envelope', async () => {
    const lcdMod = {
      lease: vi
        .fn()
        .mockRejectedValue(
          axiosError(404, { code: 5, message: 'lease not found', details: [] }),
        ),
    };
    const converterNs = { QueryLeaseResponse: { fromJSON: (o: unknown) => o } };
    const adapted = adaptModule(lcdMod, converterNs);

    await expect(adapted.lease({})).rejects.toMatchObject({
      code: ManifestMCPErrorCode.NOT_FOUND,
      details: { httpStatus: 404, grpcCode: 5, grpcMessage: 'lease not found' },
    });
  });

  it('keeps a proxy 404 as QUERY_FAILED', async () => {
    const lcdMod = {
      lease: vi.fn().mockRejectedValue(
        axiosError(404, {
          error: 'not_found',
          message: 'Endpoint not found',
        }),
      ),
    };
    const converterNs = { QueryLeaseResponse: { fromJSON: (o: unknown) => o } };
    const adapted = adaptModule(lcdMod, converterNs);

    await expect(adapted.lease({})).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });

  it('passes verbatim protobuf map keys through to fromJSON', async () => {
    const lcdMod = {
      labels: vi.fn().mockResolvedValue({
        labels_by_name: {
          customer_tier: { display_name: 'Gold' },
        },
      }),
    };
    const converterNs = {
      QueryLabelsResponse: {
        fromJSON: (object: {
          labelsByName: Record<string, { displayName: string }>;
        }) => ({
          labelsByName: Object.fromEntries(
            Object.entries(object.labelsByName).map(([key, value]) => [
              key,
              { displayName: value.displayName },
            ]),
          ),
        }),
      },
    };
    const adapted = adaptModule(lcdMod, converterNs);

    await expect(adapted.labels()).resolves.toEqual({
      labelsByName: {
        customer_tier: { displayName: 'Gold' },
      },
    });
  });
});

describe('snakeToCamelDeep', () => {
  it('converts simple snake_case keys', () => {
    const view = snakeToCamelDeep({
      provider_uuid: 'abc',
      lease_uuid: '123',
    }) as { providerUuid: string; leaseUuid: string };
    expect(view.providerUuid).toBe('abc');
    expect(view.leaseUuid).toBe('123');
    expect('providerUuid' in view).toBe(true);
    expect('leaseUuid' in view).toBe(true);
    // The Proxy is an intermediate fromJSON view: wire keys intentionally
    // remain enumerable so protobuf map keys cannot be rewritten.
    expect(Object.keys(view)).toEqual(['provider_uuid', 'lease_uuid']);
    expect({ ...view }).toEqual({
      provider_uuid: 'abc',
      lease_uuid: '123',
    });
    expect(JSON.parse(JSON.stringify(view))).toEqual({
      provider_uuid: 'abc',
      lease_uuid: '123',
    });
  });

  it('converts nested objects', () => {
    const view = snakeToCamelDeep({ outer_key: { inner_key: 'val' } }) as {
      outerKey: { innerKey: string };
    };
    expect(view.outerKey.innerKey).toBe('val');
  });

  it('converts arrays of objects', () => {
    const view = snakeToCamelDeep([{ foo_bar: 1 }, { baz_qux: 2 }]) as [
      { fooBar: number },
      { bazQux: number },
    ];
    expect(view[0].fooBar).toBe(1);
    expect(view[1].bazQux).toBe(2);
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
    const view = snakeToCamelDeep({ providerUuid: 'abc' }) as {
      providerUuid: string;
    };
    expect(view.providerUuid).toBe('abc');
  });

  it('handles empty objects', () => {
    expect(Object.keys(snakeToCamelDeep({}) as object)).toEqual([]);
  });

  it('handles deeply nested structures', () => {
    const view = snakeToCamelDeep({
      credit_account: {
        balance: { amount: '100', denom: 'umfx' },
        tenant_address: 'manifest1abc',
      },
    }) as {
      creditAccount: {
        balance: { amount: string; denom: string };
        tenantAddress: string;
      };
    };
    expect(view.creditAccount.balance).toEqual({
      amount: '100',
      denom: 'umfx',
    });
    expect(view.creditAccount.tenantAddress).toBe('manifest1abc');
  });

  it('handles arrays nested inside objects', () => {
    const view = snakeToCamelDeep({
      lease_items: [
        { sku_uuid: 'a', item_count: 1 },
        { sku_uuid: 'b', item_count: 2 },
      ],
    }) as {
      leaseItems: Array<{ skuUuid: string; itemCount: number }>;
    };
    expect(view.leaseItems[0].skuUuid).toBe('a');
    expect(view.leaseItems[0].itemCount).toBe(1);
    expect(view.leaseItems[1].skuUuid).toBe('b');
    expect(view.leaseItems[1].itemCount).toBe(2);
  });

  it('handles keys with uppercase after underscore', () => {
    const view = snakeToCamelDeep({ status_OK: true }) as { statusOK: boolean };
    expect(view.statusOK).toBe(true);
  });

  it('handles keys with digits after underscore', () => {
    const view = snakeToCamelDeep({ v1beta1_balance: '100' }) as {
      v1beta1Balance: string;
    };
    expect(view.v1beta1Balance).toBe('100');
  });

  it('preserves protobuf map entry keys while aliasing fields in their values', () => {
    const view = snakeToCamelDeep({
      labels_by_name: {
        customer_tier: { display_name: 'Gold' },
      },
    }) as {
      labelsByName: Record<string, { displayName: string }>;
    };

    expect(Object.keys(view.labelsByName)).toEqual(['customer_tier']);
    expect(view.labelsByName.customer_tier.displayName).toBe('Gold');
    expect('customer_tier' in view.labelsByName).toBe(true);
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
    const converterInput = converter.fromJSON.mock.calls[0][0] as {
      totalCount: string;
      someData: string;
    };
    expect(converterInput.totalCount).toBe('5');
    expect(converterInput.someData).toBe('raw');
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
  it.each(['smartContractState', 'rawContractState'] as const)(
    'converts Uint8Array queryData to base64 for %s',
    async (method) => {
      const queryBytes = toUtf8(JSON.stringify({ config: {} }));
      const mockFn = vi.fn().mockResolvedValue({ data: 'result' });
      const patched = patchWasmQueryData({ [method]: mockFn, req: {} });

      await (patched[method] as (...args: unknown[]) => unknown)({
        address: 'manifest1abc',
        queryData: queryBytes,
      });

      expect(mockFn).toHaveBeenCalledWith({
        address: 'manifest1abc',
        queryData: toBase64(queryBytes),
      });
    },
  );

  it('passes through non-Uint8Array queryData unchanged', async () => {
    const mockFn = vi.fn().mockResolvedValue({ data: 'result' });
    const patched = patchWasmQueryData({ smartContractState: mockFn, req: {} });

    await (patched.smartContractState as (...args: unknown[]) => unknown)({
      address: 'manifest1abc',
      queryData: 'already-base64',
    });

    expect(mockFn).toHaveBeenCalledWith({
      address: 'manifest1abc',
      queryData: 'already-base64',
    });
  });

  it('re-encodes object data as base64 JSON for fromJSON compatibility', async () => {
    const contractResponse = { poa_admin: 'manifest1abc', rate: '0.379' };
    const mockFn = vi.fn().mockResolvedValue({ data: contractResponse });
    const patched = patchWasmQueryData({ smartContractState: mockFn, req: {} });

    const result = (await (
      patched.smartContractState as (...args: unknown[]) => Promise<unknown>
    )({
      address: 'manifest1abc',
      queryData: 'eyJjb25maWciOnt9fQ==',
    })) as { data: unknown };

    expect(typeof result.data).toBe('string');
    expect(result.data).toBe(
      toBase64(toUtf8(JSON.stringify(contractResponse))),
    );
  });

  it('passes through string data unchanged', async () => {
    const mockFn = vi
      .fn()
      .mockResolvedValue({ data: 'already-base64-encoded' });
    const patched = patchWasmQueryData({ smartContractState: mockFn, req: {} });

    const result = (await (
      patched.smartContractState as (...args: unknown[]) => Promise<unknown>
    )({
      address: 'manifest1abc',
      queryData: 'eyJjb25maWciOnt9fQ==',
    })) as { data: unknown };

    expect(result.data).toBe('already-base64-encoded');
  });

  it('warns and skips methods that do not exist on the module', () => {
    const spy = {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    expect(() =>
      patchWasmQueryData({ otherMethod: vi.fn(), req: {} }, spy),
    ).not.toThrow();
    expect(spy.warn).toHaveBeenCalledTimes(2);
    expect(spy.warn).toHaveBeenCalledWith(
      expect.stringContaining('smartContractState'),
    );
    expect(spy.warn).toHaveBeenCalledWith(
      expect.stringContaining('rawContractState'),
    );
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
