import { describe, expect, it } from 'vitest';
import { resolveCallSignal } from './options.js';

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
});
