import { describe, it, expect, vi } from 'vitest';
import { mapWithConcurrency } from './browseCatalog.js';

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

  it('propagates errors from fn', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
  });
});
