import { describe, expect, it, vi } from 'vitest';
import type { ReadCtx } from '../ctx.js';
import { ManifestMCPErrorCode } from '../types.js';
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

  // Real timers with a small deadline, NOT fake ones: `AbortSignal.timeout` runs on an internal
  // timer that `vi.useFakeTimers()` does not control. The fake-timer scaffolding this test used to
  // carry was decorative — `advanceTimersByTimeAsync(1000)` returned immediately with no fake timer
  // pending and the assertion then waited out a real second (verified, ENG-710).
  it('timeout rejects with a TimeoutError (distinct from a caller AbortError)', async () => {
    const read = vi.fn(() => new Promise<number>(() => {})); // never resolves
    await expect(
      withReadSignal(fakeCtx(), read, { timeout: 20 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('composed { signal, timeout } bounds the read on its deadline leg', async () => {
    const ac = new AbortController();
    const read = vi.fn(() => new Promise<number>(() => {})); // never resolves
    await expect(
      withReadSignal(fakeCtx(), read, { signal: ac.signal, timeout: 20 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(read).toHaveBeenCalledTimes(1); // the deadline bounded the AWAIT, not the acquire
  });

  it('rejects a malformed timeout before acquiring a token or reading', async () => {
    const acquire = vi.fn(async () => {});
    const read = vi.fn(async () => 1);
    await expect(
      withReadSignal(fakeCtx(acquire), read, { timeout: 0 }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    expect(acquire).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
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

  // The MCP wire shape. Every test above aborts with `new Error(...)`, but the SDK types the
  // cancellation notification's reason as `z.string().optional()` and does
  // `controller.abort(notification.params.reason)` — and when the CLIENT's own request timeout
  // fires it cancels with `String(err)`. So the value thrown is a bare string with no `message`
  // and no `stack`, and it must survive by IDENTITY (hence `toBe`, not `toThrow`).
  describe('a non-Error abort reason (the common MCP case, ENG-710)', () => {
    it('propagates a bare string from the pre-check', async () => {
      const ac = new AbortController();
      ac.abort('McpError: MCP error -32001: Request timed out');
      await expect(
        withReadSignal(
          fakeCtx(),
          vi.fn(async () => 1),
          { signal: ac.signal },
        ),
      ).rejects.toBe('McpError: MCP error -32001: Request timed out');
    });

    it('propagates a bare string from the abort listener', async () => {
      const ac = new AbortController();
      const p = withReadSignal(fakeCtx(), () => new Promise<number>(() => {}), {
        signal: ac.signal,
      });
      ac.abort('user cancelled');
      await expect(p).rejects.toBe('user cancelled');
    });

    // The `??`-not-`||` pin, at the seam rather than on the helper: an empty string is a value
    // the caller chose and is on the MCP wire.
    it('preserves an empty-string reason verbatim', async () => {
      const ac = new AbortController();
      const p = withReadSignal(fakeCtx(), () => new Promise<number>(() => {}), {
        signal: ac.signal,
      });
      ac.abort('');
      await expect(p).rejects.toBe('');
    });

    // ...whereas a reason carrying NOTHING is normalized, at every site. This is what the
    // built-in `signal.throwIfAborted()` would NOT do — it rethrows `null` raw, which
    // `withErrorHandling` renders as the literal message "null" (the ENG-703 defect shape).
    it.each([
      ['pre-check', true],
      ['abort listener', false],
    ])('substitutes an AbortError for a null reason (%s)', async (_l, pre) => {
      const ac = new AbortController();
      if (pre) ac.abort(null);
      const p = withReadSignal(fakeCtx(), () => new Promise<number>(() => {}), {
        signal: ac.signal,
      });
      if (!pre) ac.abort(null);
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    });
  });

  describe('the rate-limit token wait (ENG-710)', () => {
    it('threads the effective signal into acquireRateLimit', async () => {
      const acquire = vi.fn(async (_signal?: AbortSignal) => {});
      const ac = new AbortController();
      await withReadSignal(fakeCtx(acquire), async () => 1, {
        signal: ac.signal,
      });
      // By reference: with a lone signal `resolveCallSignal` returns the caller's own instance,
      // so the object core waits on IS the one the host will abort.
      expect(acquire).toHaveBeenCalledWith(ac.signal);
    });

    it('forwards the COMPOSED signal, not the caller signal, when a timeout is also set', async () => {
      const acquire = vi.fn(async (_signal?: AbortSignal) => {});
      const ac = new AbortController();
      await withReadSignal(fakeCtx(acquire), async () => 1, {
        signal: ac.signal,
        timeout: 10_000,
      });
      const forwarded = acquire.mock.calls[0]?.[0];
      expect(forwarded).toBeInstanceOf(AbortSignal);
      expect(forwarded).not.toBe(ac.signal);
    });

    it('the fast path acquires with no argument at all', async () => {
      const acquire = vi.fn(async (_signal?: AbortSignal) => {});
      await withReadSignal(fakeCtx(acquire), async () => 1);
      expect(acquire.mock.calls[0]).toHaveLength(0);
    });

    // The post-token re-check is NOT dead code now that acquireRateLimit is signal-aware:
    // `ctx` is taken structurally, so a hand-built ctx, a test double, or — under the caret
    // peerDependency range — an older core that ignores the argument, is gated by nothing else.
    // This is the core-level mirror of the four lease tests ENG-707 added.
    it('still gates the read when the chain ignores the signal it was handed', async () => {
      const ac = new AbortController();
      const acquire = vi.fn(async () => {
        ac.abort('cancelled mid-wait'); // ignores its argument, as every mock in the tree does
      });
      const read = vi.fn(async () => 1);
      await expect(
        withReadSignal(fakeCtx(acquire), read, { signal: ac.signal }),
      ).rejects.toBe('cancelled mid-wait');
      expect(acquire).toHaveBeenCalled(); // non-vacuity
      expect(read).not.toHaveBeenCalled();
    });
  });

  // Regression guard for the removed `readPromise.catch(() => {})`. The swallow was redundant
  // because `.then(resolve, reject)` is attached synchronously in the same tick — but if a
  // refactor ever moves that attachment, a losing read's late rejection becomes an unhandled
  // rejection, which can take down a Node MCP server. Assert it directly.
  it('a losing read that rejects AFTER the abort raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const ac = new AbortController();
      const p = withReadSignal(
        fakeCtx(),
        () =>
          new Promise<number>((_res, rej) =>
            setTimeout(() => rej(new Error('late rpc failure')), 10),
          ),
        { signal: ac.signal },
      );
      ac.abort(new Error('cancelled'));
      await expect(p).rejects.toThrow('cancelled');
      await new Promise((r) => setTimeout(r, 40)); // let the loser settle + a macrotask turn
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
