import { describe, expect, it, vi } from 'vitest';
import { findSkuUuid } from './find-sku-uuid.js';

/**
 * Mock the workspace deps. `findSkuUuid` only needs a `clientManager` with
 * a `getQueryClient()` method that returns a query-client with the SKU
 * query path. Tests inject canned SKU lists per scenario.
 */

interface MockSku {
  uuid: string;
  providerUuid: string;
  name: string;
}

function makeMockClientManager(skus: MockSku[]) {
  return {
    getQueryClient: vi.fn().mockResolvedValue({
      liftedinit: {
        sku: {
          v1: {
            sKUs: vi.fn().mockResolvedValue({
              skus,
              pagination: { nextKey: new Uint8Array(), total: BigInt(skus.length) },
            }),
          },
        },
      },
    }),
  } as unknown as Parameters<typeof findSkuUuid>[0];
}

describe('findSkuUuid', () => {
  it('returns skuUuid + providerUuid for a matching size', async () => {
    const clientManager = makeMockClientManager([
      { uuid: 'sku-aaa-111', providerUuid: 'prov-aaa', name: 'small' },
      { uuid: 'sku-bbb-222', providerUuid: 'prov-bbb', name: 'medium' },
    ]);
    const result = await findSkuUuid(clientManager, 'small');
    expect(result).toEqual({
      skuUuid: 'sku-aaa-111',
      providerUuid: 'prov-aaa',
    });
  });

  it('throws ManifestMCPError(QUERY_FAILED) when no SKU matches', async () => {
    const clientManager = makeMockClientManager([
      { uuid: 'sku-aaa-111', providerUuid: 'prov-aaa', name: 'small' },
    ]);
    await expect(findSkuUuid(clientManager, 'docker-mega')).rejects.toMatchObject({
      name: 'ManifestMCPError',
      code: 'QUERY_FAILED',
    });
  });

  it('error message lists available SKU names for caller debugging', async () => {
    const clientManager = makeMockClientManager([
      { uuid: 'sku-a', providerUuid: 'p1', name: 'small' },
      { uuid: 'sku-b', providerUuid: 'p2', name: 'medium' },
      { uuid: 'sku-c', providerUuid: 'p3', name: 'large' },
    ]);
    try {
      await findSkuUuid(clientManager, 'nonexistent');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('"nonexistent" not found');
      expect((err as Error).message).toContain('small');
      expect((err as Error).message).toContain('medium');
      expect((err as Error).message).toContain('large');
    }
  });

  it('throws on empty SKU list with "Available: " (empty) suffix', async () => {
    const clientManager = makeMockClientManager([]);
    try {
      await findSkuUuid(clientManager, 'small');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toContain('"small" not found');
      // Empty SKU list → 'Available: ' with empty join. Verify the
      // error surfaces this distinctly rather than crashing on the empty
      // array.
      expect((err as Error).message).toMatch(/Available: $/);
    }
  });

  it('matches first SKU on name (returns first match if duplicates exist)', async () => {
    // Defensive: chain shouldn't emit dupes, but verify the for-of
    // semantics short-circuit on first match.
    const clientManager = makeMockClientManager([
      { uuid: 'sku-first', providerUuid: 'p1', name: 'small' },
      { uuid: 'sku-second', providerUuid: 'p2', name: 'small' },
    ]);
    const result = await findSkuUuid(clientManager, 'small');
    expect(result.skuUuid).toBe('sku-first');
  });
});
