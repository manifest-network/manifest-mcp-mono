import { noopLogger } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { describe, expect, it, vi } from 'vitest';
import type { FredReadCtx } from '../ctx.js';
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
          {
            uuid: 'p1',
            address: 'm1',
            apiUrl: 'http://localhost:8080',
            active: true,
          },
        ],
        skus: [
          {
            uuid: 'a',
            name: 'docker-micro',
            providerUuid: 'p1',
            basePrice: { amount: '100', denom: 'umfx' },
          },
          {
            uuid: 'b',
            name: 'docker-micro',
            providerUuid: 'p2',
            basePrice: { amount: '120', denom: 'umfx' },
          },
        ],
      },
    });
    const fetchSpy = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{"status":"ok"}'),
    );
    const ctx: FredReadCtx = {
      // `query`/`chain` keep `as never` deliberately — `qc` is a partial
      // makeMockQueryClient (not assignable to ManifestQueryClient) and `chain`
      // is `{}`; neither is cleanly typeable. `fetch` IS, so type the spy so a
      // wrong fetch shape/return-type is caught instead of swallowed by a cast.
      query: qc as never,
      chain: {} as never,
      fetch: fetchSpy,
      logger: noopLogger,
    };
    const res = await browseCatalog(ctx);

    // GOLDEN — the exact object captured from the pre-refactor positional run.
    const GOLDEN = {
      providers: [
        {
          uuid: 'p1',
          address: 'm1',
          apiUrl: 'http://localhost:8080',
          active: true,
          healthy: true,
          providerUuid: undefined,
        },
      ],
      skus: [
        {
          name: 'docker-micro',
          sku_uuid: 'a',
          provider_uuid: 'p1',
          provider_url: 'http://localhost:8080',
          price: '100',
          unit: 'umfx',
          active: true,
        },
        {
          name: 'docker-micro',
          sku_uuid: 'b',
          provider_uuid: 'p2',
          provider_url: null,
          price: '120',
          unit: 'umfx',
          active: true,
        },
      ],
    };
    expect(res).toEqual(GOLDEN);
    expect(res).not.toHaveProperty('tiers');
    // ctx.fetch is threaded down to the provider-health call.
    expect(fetchSpy).toHaveBeenCalled();
  });
});
