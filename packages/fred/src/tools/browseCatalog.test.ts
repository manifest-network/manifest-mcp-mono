import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { describe, expect, it, vi } from 'vitest';
import { browseCatalog, mapWithConcurrency } from './browseCatalog.js';

describe('mapWithConcurrency', () => {
  it('preserves input order even when items resolve out of order', async () => {
    const items = [1, 2, 3, 4, 5];
    // Items resolve in reverse order (5 resolves first, 1 resolves last)
    const results = await mapWithConcurrency(items, 5, async (item) => {
      await new Promise((r) => setTimeout(r, (6 - item) * 10));
      return item * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('limits concurrency to the specified cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually uses concurrency
  });

  it('works when items count is less than limit', async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (x) => x * 2);
    expect(results).toEqual([2, 4]);
  });

  it('handles empty items array', async () => {
    const fn = vi.fn();
    const results = await mapWithConcurrency([], 5, fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('clamps limit to at least 1 when given 0', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 0, async (x) => x * 2);
    expect(results).toEqual([2, 4, 6]);
  });

  it('propagates errors from fn', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('browseCatalog', () => {
  it('ENG-258: returns a flat skus[] with uuid + provider + split provider fields', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providers: [
          { uuid: 'p1', address: 'm1', apiUrl: 'http://p1', active: true },
        ],
        skus: [
          {
            uuid: 'a',
            name: 'docker-micro',
            providerUuid: 'p1',
            basePrice: { amount: '100', denom: 'umfx' },
            unit: 1, // numeric enum — the prod LCD-decoded form (UNIT_PER_HOUR)
          },
          {
            uuid: 'b',
            name: 'docker-micro',
            providerUuid: 'p2',
            basePrice: { amount: '120', denom: 'umfx' },
            unit: 'UNIT_PER_DAY', // string form — tolerated for raw/mock inputs
          },
        ],
      },
    });
    const res = await browseCatalog(
      qc as never,
      async () => new Response('{"status":"ok"}'),
    );
    expect(res).not.toHaveProperty('tiers');
    expect(res.skus).toEqual(
      expect.arrayContaining([
        {
          name: 'docker-micro',
          sku_uuid: 'a',
          provider_uuid: 'p1',
          provider_url: 'http://p1',
          price: '100',
          denom: 'umfx',
          unit: 'UNIT_PER_HOUR',
          active: true,
        },
        {
          name: 'docker-micro',
          sku_uuid: 'b',
          provider_uuid: 'p2',
          provider_url: null,
          price: '120',
          denom: 'umfx',
          unit: 'UNIT_PER_DAY',
          active: true,
        },
      ]),
    );
  });

  it('normalizes the chain zero-value and an absent unit to stable strings', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providers: [
          { uuid: 'p1', address: 'm1', apiUrl: 'http://p1', active: true },
        ],
        skus: [
          { uuid: 'z', name: 'unspecified', providerUuid: 'p1', unit: 0 },
          // no `unit` field at all → UNRECOGNIZED (the codec's absent sentinel)
          { uuid: 'm', name: 'missing', providerUuid: 'p1' },
        ],
      },
    });
    const res = await browseCatalog(
      qc as never,
      async () => new Response('{"status":"ok"}'),
    );
    const byUuid = Object.fromEntries(res.skus.map((s) => [s.sku_uuid, s]));
    expect(byUuid.z.unit).toBe('UNIT_UNSPECIFIED');
    expect(byUuid.m.unit).toBe('UNRECOGNIZED');
  });
});
