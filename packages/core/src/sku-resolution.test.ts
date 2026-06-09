import { describe, expect, it } from 'vitest';
import { makeMockQueryClient } from './__test-utils__/mocks.js';
import { listSkuCandidates, resolveSku } from './sku-resolution.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

function qc(
  skus: Array<{
    uuid: string;
    name: string;
    providerUuid: string;
    basePrice?: { amount: string; denom: string };
  }>,
) {
  return makeMockQueryClient({ sku: { skus } }) as never;
}

const dup = [
  {
    uuid: 'sku-p1',
    name: 'docker-micro',
    providerUuid: 'prov-1',
    basePrice: { amount: '100', denom: 'umfx' },
  },
  {
    uuid: 'sku-p2',
    name: 'docker-micro',
    providerUuid: 'prov-2',
    basePrice: { amount: '120', denom: 'umfx' },
  },
];

describe('resolveSku', () => {
  it('resolves a unique name to its single candidate', async () => {
    const r = await resolveSku(qc([dup[0]]), { size: 'docker-micro' });
    expect(r).toMatchObject({
      skuUuid: 'sku-p1',
      providerUuid: 'prov-1',
      name: 'docker-micro',
      active: true,
    });
  });

  it('throws QUERY_FAILED listing available names when no name matches', async () => {
    await expect(
      resolveSku(qc([dup[0]]), { size: 'nope' }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });

  it('throws SKU_AMBIGUOUS with candidates when a name matches >1 and no disambiguator', async () => {
    let thrown: unknown;
    try {
      await resolveSku(qc(dup), { size: 'docker-micro' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManifestMCPError);
    const err = thrown as ManifestMCPError;
    expect(err.code).toBe(ManifestMCPErrorCode.SKU_AMBIGUOUS);
    expect(err.details).toMatchObject({
      reason: 'AMBIGUOUS_SKU_NAME',
      size: 'docker-micro',
    });
    expect((err.details as { candidates: unknown[] }).candidates).toHaveLength(
      2,
    );
  });

  it('narrows by providerUuid', async () => {
    const r = await resolveSku(qc(dup), {
      size: 'docker-micro',
      providerUuid: 'prov-2',
    });
    expect(r.skuUuid).toBe('sku-p2');
  });

  it('throws QUERY_FAILED when the named SKU is not offered by the requested provider', async () => {
    await expect(
      resolveSku(qc(dup), { size: 'docker-micro', providerUuid: 'prov-9' }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
  });

  it('throws SKU_AMBIGUOUS for same-provider duplicates even with providerUuid (needs sku_uuid)', async () => {
    const sameProv = [
      { uuid: 'a', name: 'docker-micro', providerUuid: 'prov-1' },
      { uuid: 'b', name: 'docker-micro', providerUuid: 'prov-1' },
    ];
    await expect(
      resolveSku(qc(sameProv), {
        size: 'docker-micro',
        providerUuid: 'prov-1',
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.SKU_AMBIGUOUS });
  });

  it('skuUuid bypasses name lookup and wins', async () => {
    const r = await resolveSku(qc(dup), {
      size: 'ignored',
      skuUuid: 'sku-p2',
    });
    expect(r).toMatchObject({ skuUuid: 'sku-p2', providerUuid: 'prov-2' });
  });

  it('skuUuid not found among active SKUs throws QUERY_FAILED', async () => {
    await expect(
      resolveSku(qc(dup), { size: 'x', skuUuid: 'missing' }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
  });

  it('skuUuid + mismatched providerUuid throws INVALID_CONFIG', async () => {
    await expect(
      resolveSku(qc(dup), {
        size: 'x',
        skuUuid: 'sku-p2',
        providerUuid: 'prov-1',
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
  });

  it('empty-string skuUuid falls through to name resolution', async () => {
    const r = await resolveSku(qc([dup[0]]), {
      size: 'docker-micro',
      skuUuid: '',
    });
    expect(r.skuUuid).toBe('sku-p1');
  });

  it('maps basePrice to price, and omits price when basePrice is absent', async () => {
    const withPrice = await resolveSku(
      qc([
        {
          uuid: 'sku-priced',
          name: 'priced',
          providerUuid: 'prov-1',
          basePrice: { amount: '100', denom: 'umfx' },
        },
      ]),
      { size: 'priced' },
    );
    expect(withPrice.price).toEqual({ amount: '100', denom: 'umfx' });

    const noPrice = await resolveSku(
      qc([{ uuid: 'sku-free', name: 'free', providerUuid: 'prov-1' }]),
      { size: 'free' },
    );
    expect(noPrice.price).toBeUndefined();
  });
});

describe('listSkuCandidates', () => {
  it('returns all matches for a name (no throw on duplicates)', async () => {
    const list = await listSkuCandidates(qc(dup), 'docker-micro');
    expect(list.map((c) => c.skuUuid).sort()).toEqual(['sku-p1', 'sku-p2']);
  });
  it('filters by providerUuid when given', async () => {
    const list = await listSkuCandidates(qc(dup), 'docker-micro', 'prov-1');
    expect(list).toHaveLength(1);
    expect(list[0].skuUuid).toBe('sku-p1');
  });
});
