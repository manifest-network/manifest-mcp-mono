import {
  isRetryableError,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { describe, expect, it } from 'vitest';
import { findSkuUuid } from './deployManifest.js';

function qcWithTwoProviders() {
  return makeMockQueryClient({
    sku: {
      providers: [
        { uuid: 'prov-1', address: 'm1', apiUrl: 'http://p1', active: true },
        { uuid: 'prov-2', address: 'm2', apiUrl: 'http://p2', active: true },
      ],
      skus: [
        {
          uuid: 'sku-compute',
          name: 'docker-micro',
          providerUuid: 'prov-1',
          basePrice: { amount: '1', denom: 'umfx' },
        },
        {
          uuid: 'sku-store-p2',
          name: 'storage-10g',
          providerUuid: 'prov-2',
          basePrice: { amount: '1', denom: 'umfx' },
        },
      ],
      providerLookup: {
        'prov-1': { provider: { apiUrl: 'http://p1' } } as any,
      },
    },
  });
}

describe('findSkuUuid provider filter (ENG-258 #2)', () => {
  it('rejects a tier that exists only on a different provider with non-retryable INVALID_CONFIG', async () => {
    const qc = qcWithTwoProviders();
    let thrown: unknown;
    try {
      await findSkuUuid(qc as any, 'storage-10g', 'prov-1');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManifestMCPError);
    expect((thrown as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.INVALID_CONFIG,
    );
    expect((thrown as ManifestMCPError).message).toContain('prov-1');
    expect(isRetryableError(thrown)).toBe(false);
  });

  it('resolves a tier on the named provider', async () => {
    const qc = qcWithTwoProviders();
    const { skuUuid } = await findSkuUuid(qc as any, 'storage-10g', 'prov-2');
    expect(skuUuid).toBe('sku-store-p2');
  });
});
