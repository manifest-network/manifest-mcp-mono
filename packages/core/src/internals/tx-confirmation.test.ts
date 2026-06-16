import { describe, expect, it, vi } from 'vitest';
import { withTxConfirmation } from './tx-confirmation.js';

describe('withTxConfirmation', () => {
  it('no signal/timeout: returns the broadcast() result', async () => {
    const broadcast = vi.fn(async () => 'txhash');
    const out = await withTxConfirmation(broadcast);
    expect(out).toBe('txhash');
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('already-aborted signal: throws the reason and broadcast is NEVER called (no tx sent)', async () => {
    const broadcast = vi.fn(async () => 'txhash');
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(
      withTxConfirmation(broadcast, { signal: ac.signal }),
    ).rejects.toThrow('cancelled');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('abort DURING the await: rejects the caller reason AND broadcast was called exactly once (no re-broadcast)', async () => {
    const ac = new AbortController();
    const broadcast = vi.fn(() => new Promise<string>(() => {})); // never resolves
    const p = withTxConfirmation(broadcast, { signal: ac.signal });
    ac.abort(new Error('user cancelled'));
    await expect(p).rejects.toThrow('user cancelled');
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('timeout: rejects with a TimeoutError and broadcast was called exactly once', async () => {
    vi.useFakeTimers();
    try {
      const broadcast = vi.fn(() => new Promise<string>(() => {})); // never resolves
      const p = withTxConfirmation(broadcast, { timeout: 1000 });
      const assertion = expect(p).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with the broadcast result when it wins the race', async () => {
    const ac = new AbortController();
    const out = await withTxConfirmation(async () => 'committed', {
      signal: ac.signal,
    });
    expect(out).toBe('committed');
  });
});
