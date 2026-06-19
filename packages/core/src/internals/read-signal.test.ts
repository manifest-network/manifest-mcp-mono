import { describe, expect, it, vi } from 'vitest';
import type { ReadCtx } from '../ctx.js';
import { withReadSignal } from './read-signal.js';

// withReadSignal needs only ctx.chain.acquireRateLimit — a minimal fake suffices.
function fakeCtx(acquire = vi.fn(async () => {})): Pick<ReadCtx, 'chain'> {
  return { chain: { acquireRateLimit: acquire } as never };
}

describe('withReadSignal', () => {
  it('no-op fast path when no signal/timeout: acquires once, runs the read', async () => {
    const acquire = vi.fn(async () => {});
    const read = vi.fn(async () => 42);
    const out = await withReadSignal(fakeCtx(acquire), read);
    expect(out).toBe(42);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('already-aborted caller signal: throws the reason BEFORE acquiring a token or running the read', async () => {
    const acquire = vi.fn(async () => {});
    const read = vi.fn(async () => 1);
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(
      withReadSignal(fakeCtx(acquire), read, { signal: ac.signal }),
    ).rejects.toThrow('cancelled');
    expect(acquire).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('timeout rejects with a TimeoutError (distinct from a caller AbortError)', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(() => new Promise<number>(() => {})); // never resolves
      const p = withReadSignal(fakeCtx(), read, { timeout: 1000 });
      const assertion = expect(p).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('caller abort DURING the read rejects with the caller reason', async () => {
    const ac = new AbortController();
    const read = vi.fn(() => new Promise<number>(() => {})); // never resolves
    const p = withReadSignal(fakeCtx(), read, { signal: ac.signal });
    ac.abort(new Error('user cancelled'));
    await expect(p).rejects.toThrow('user cancelled');
  });

  it('resolves with the read result when it wins the race', async () => {
    const ac = new AbortController();
    const out = await withReadSignal(fakeCtx(), async () => 'ok', {
      signal: ac.signal,
    });
    expect(out).toBe('ok');
  });
});
