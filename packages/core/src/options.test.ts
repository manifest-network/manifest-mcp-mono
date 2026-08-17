import { describe, expect, it, vi } from 'vitest';
import { abortableSleep, abortReason, resolveCallSignal } from './options.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/**
 * Resolve when `signal` aborts. Preferred over sleeping past a deadline: `AbortSignal.timeout`
 * runs on an INTERNAL timer that `vi.useFakeTimers()` does NOT control (verified — the fake-timer
 * scaffolding these tests used to carry was decorative and the assertions burned a real second),
 * so every deadline test here uses real timers with a small value and waits on the event itself.
 */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

describe('resolveCallSignal', () => {
  it('returns undefined when neither signal nor timeout is given', () => {
    expect(resolveCallSignal(undefined)).toBeUndefined();
    expect(resolveCallSignal({})).toBeUndefined();
  });
  it('returns the caller signal verbatim when only signal is given', () => {
    const ac = new AbortController();
    expect(resolveCallSignal({ signal: ac.signal })).toBe(ac.signal);
  });
  it('returns a signal that aborts with a TimeoutError after the timeout', async () => {
    const sig = resolveCallSignal({ timeout: 5 });
    expect(sig).toBeDefined();
    expect(sig!.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(sig!.aborted).toBe(true);
    expect((sig!.reason as DOMException).name).toBe('TimeoutError');
  });
  it('combines signal + timeout: aborts (with AbortError) when the caller signal fires first', () => {
    const ac = new AbortController();
    const sig = resolveCallSignal({ signal: ac.signal, timeout: 10_000 });
    expect(sig).toBeDefined();
    ac.abort(new DOMException('cancelled', 'AbortError'));
    expect(sig!.aborted).toBe(true);
    expect((sig!.reason as DOMException).name).toBe('AbortError');
  });

  // The OTHER direction of the composed signal, and the only one that exercises the
  // `AbortSignal.any` branch on its timeout leg. Untested before ENG-710, and no in-repo caller
  // passes `timeout` at all — every registerTool site passes `signal` only — so this branch is
  // reachable only from an external SDK consumer. It was also silently broken in Node until
  // 22.16.0 / 24.0.0 (nodejs#57736: a timeout signal inside a composite was GC'd before its timer
  // fired, so the deadline never fired; fixed by #57867 adding them to `gcPersistentSignals`).
  // Our engines floor is above that, but `engines` is advisory for a published SDK, core builds
  // `platform: "neutral"`, and `AbortSignal.any` has a Safari 17.4 floor — so a polyfill can
  // reintroduce the class. The failure mode is silent, hence a standing guard.
  it('combines signal + timeout: aborts (with TimeoutError) when the deadline fires first', async () => {
    const ac = new AbortController();
    const sig = resolveCallSignal({ signal: ac.signal, timeout: 20 });
    expect(sig).toBeDefined();
    expect(sig).not.toBe(ac.signal); // non-vacuity: the composed branch, not the short-circuit
    await aborted(sig!);
    expect((sig!.reason as DOMException).name).toBe('TimeoutError');
    expect(ac.signal.aborted).toBe(false); // the caller's own leg is left untouched
  });

  describe('timeout validation (ENG-710)', () => {
    // `AbortSignal.timeout` is strict, so without this guard a raw Node `RangeError`/`TypeError`
    // escapes a helper documented as "merge two signals".
    it.each([
      ['negative', -1],
      ['zero', 0],
      ['fractional', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a numeric string', '500' as unknown as number],
      ['null', null as unknown as number],
      // The two that Node ACCEPTS: it takes the whole uint32 range, so these throw nothing and
      // silently become a 1ms deadline (TimeoutOverflowWarning) — a caller asking for ~25 days
      // gets an instant timeout. A validator written to mirror Node's own bounds misses them.
      ['2**31 (silent 1ms overflow)', 2 ** 31],
      ['2**32-1 (silent 1ms overflow)', 2 ** 32 - 1],
      ['2**32 (Node RangeError)', 2 ** 32],
    ])('rejects %s', (_label, timeout) => {
      expect(() => resolveCallSignal({ timeout })).toThrow(ManifestMCPError);
      try {
        resolveCallSignal({ timeout });
      } catch (err) {
        expect((err as ManifestMCPError).code).toBe(
          ManifestMCPErrorCode.INVALID_CONFIG,
        );
        expect((err as ManifestMCPError).details).toMatchObject({
          field: 'timeout',
        });
      }
    });

    // The diagnostic must not reintroduce the defect it reports on. `JSON.stringify` THROWS on
    // a bigint, so `timeout: 1n` from a JS caller would leak a raw TypeError past a guard whose
    // whole job is to replace raw platform errors with INVALID_CONFIG.
    it('rejects a bigint through the promised path, not a raw TypeError', () => {
      const call = () =>
        resolveCallSignal({ timeout: 1n as unknown as number });
      expect(call).toThrow(ManifestMCPError);
      expect(call).not.toThrow(TypeError);
      try {
        call();
      } catch (err) {
        expect((err as ManifestMCPError).message).toContain('got 1');
      }
    });

    // ...and it must name the value it rejected. `JSON.stringify` renders both of these as
    // "null", which hides what the caller actually passed.
    it.each([
      ['NaN', Number.NaN, 'NaN'],
      ['Infinity', Number.POSITIVE_INFINITY, 'Infinity'],
      ['a string', '500' as unknown as number, '"500"'],
    ])('names %s in the message', (_label, timeout, shown) => {
      try {
        resolveCallSignal({ timeout });
        throw new Error('should have thrown');
      } catch (err) {
        expect((err as ManifestMCPError).message).toContain(`got ${shown}`);
      }
    });

    it('accepts 1 and the 32-bit ceiling', () => {
      expect(() => resolveCallSignal({ timeout: 1 })).not.toThrow();
      expect(() => resolveCallSignal({ timeout: 2_147_483_647 })).not.toThrow();
    });

    // The ceiling must be HONOURED, not merely accepted: this is the assertion that fails if the
    // bound is ever loosened to Node's own 2**32-1, because the timer would fire at 1ms.
    it('does not let the ceiling degrade into an instant deadline', async () => {
      const sig = resolveCallSignal({ timeout: 2_147_483_647 });
      await new Promise((r) => setTimeout(r, 30));
      expect(sig!.aborted).toBe(false);
    });

    // Non-vacuity: the guard sits under `opts?.timeout !== undefined`, so an absent timeout must
    // stay absent rather than being validated (Node itself rejects `undefined`).
    it('leaves an absent timeout alone', () => {
      expect(resolveCallSignal({ timeout: undefined })).toBeUndefined();
    });

    // Validation must run BEFORE anything is minted, so a throw cannot leak an armed,
    // process-pinned timer or a half-built composite.
    it('validates before minting any signal, on the composed path too', () => {
      const ac = new AbortController();
      const spy = vi.spyOn(AbortSignal, 'timeout');
      try {
        expect(() =>
          resolveCallSignal({ signal: ac.signal, timeout: -1 }),
        ).toThrow(ManifestMCPError);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('abortReason (ENG-710)', () => {
  it('returns the caller reason by identity', () => {
    const reason = new Error('user cancelled');
    const ac = new AbortController();
    ac.abort(reason);
    expect(abortReason(ac.signal)).toBe(reason);
  });

  // `??`, not `||`. An empty string is a value the caller CHOSE — over MCP the abort reason is
  // `notification.params.reason`, typed `z.string().optional()`, so '' is on the wire. Same for
  // the other falsy values a `||` regression would silently swallow.
  it.each([
    ['an empty string', ''],
    ['zero', 0],
    ['false', false],
  ])('preserves %s verbatim', (_label, reason) => {
    const ac = new AbortController();
    ac.abort(reason);
    expect(abortReason(ac.signal)).toBe(reason);
  });

  it.each([
    ['null (the spec does NOT substitute for abort(null))', null],
    ['undefined from a foreign or polyfilled signal', undefined],
  ])('substitutes an AbortError for %s', (_label, reason) => {
    const ac = new AbortController();
    ac.abort(reason);
    expect(abortReason(ac.signal)).toMatchObject({ name: 'AbortError' });
  });

  it('leaves the platform AbortError from a bare abort() alone (no double-wrap)', () => {
    const ac = new AbortController();
    ac.abort();
    expect(abortReason(ac.signal)).toBe(ac.signal.reason);
  });

  it('never relabels an expired timeout as a cancel', async () => {
    const sig = AbortSignal.timeout(5);
    await aborted(sig);
    expect(abortReason(sig)).toBe(sig.reason);
    expect((abortReason(sig) as DOMException).name).toBe('TimeoutError');
  });

  // The documented PRECONDITION is "only once the signal is known aborted". This pins what
  // misuse DOES, so nobody re-adds the self-guarding variant that would fabricate a plausible
  // AbortError for a live signal and hide the very bug the helper exists to surface.
  it('falls back for a missing signal (precondition violated)', () => {
    expect(abortReason(undefined)).toMatchObject({ name: 'AbortError' });
  });
});

describe('abortableSleep (ENG-710)', () => {
  it('resolves after the delay when no signal is given', async () => {
    const t0 = Date.now();
    await abortableSleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });

  it('rejects with the caller reason when aborted mid-sleep', async () => {
    const ac = new AbortController();
    const p = abortableSleep(10_000, ac.signal);
    ac.abort('user cancelled');
    await expect(p).rejects.toBe('user cancelled');
  });

  // A rejected promise, NOT a synchronous throw: the fred copy this replaces used
  // `throwIfAborted()`, which threw out of a promise-returning function.
  it('rejects without arming a timer when already aborted', async () => {
    const ac = new AbortController();
    ac.abort('already gone');
    const p = abortableSleep(10_000, ac.signal);
    expect(p).toBeInstanceOf(Promise);
    await expect(p).rejects.toBe('already gone');
  });

  it('normalizes a nullish reason on the pre-abort leg too', async () => {
    const ac = new AbortController();
    ac.abort(null);
    await expect(abortableSleep(10_000, ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('detaches its abort listener once the sleep resolves', async () => {
    const ac = new AbortController();
    await abortableSleep(5, ac.signal);
    // A late abort must not reject anything, nor leave a listener behind.
    expect(() => ac.abort('too late')).not.toThrow();
  });
});
