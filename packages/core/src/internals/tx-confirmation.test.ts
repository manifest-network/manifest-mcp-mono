import { describe, expect, it, vi } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { withTxConfirmation, withTxExecution } from './tx-confirmation.js';

describe('withTxConfirmation', () => {
  it('no signal/timeout: returns the broadcast() result', async () => {
    const broadcast = vi.fn(async () => 'txhash');
    const out = await withTxConfirmation(broadcast);
    expect(out).toBe('txhash');
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('already-aborted signal: rejects OPERATION_CANCELLED (no tx sent) and broadcast is NEVER called', async () => {
    // Code-review PR #102: abort/timeout surfaces as a structured
    // ManifestMCPError(OPERATION_CANCELLED) — consistent with the rest of the
    // SDK error model — not a raw DOMException. The pre-broadcast case is
    // unambiguous: nothing was sent.
    const broadcast = vi.fn(async () => 'txhash');
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    const err = await withTxConfirmation(broadcast, {
      signal: ac.signal,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect(err.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
    expect(err.message).toContain('cancelled'); // original reason embedded
    expect(err.message).toMatch(/no transaction was sent/i);
    expect((err.details as { sent?: boolean }).sent).toBe(false); // programmatic: nothing was sent
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('abort DURING the await: rejects OPERATION_CANCELLED (outcome unknown — re-query) and broadcast called exactly once', async () => {
    const ac = new AbortController();
    const broadcast = vi.fn(() => new Promise<string>(() => {})); // never resolves
    const p = withTxConfirmation(broadcast, { signal: ac.signal });
    ac.abort(new Error('user cancelled'));
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect(err.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
    expect(err.message).toContain('user cancelled');
    expect(err.message).toMatch(/re-query/i); // conservative post-send contract surfaced
    expect((err.details as { reason?: unknown }).reason).toBeInstanceOf(Error); // original reason preserved
    expect((err.details as { sent?: boolean }).sent).toBe(true); // programmatic: tx may have committed
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('timeout: rejects OPERATION_CANCELLED wrapping the TimeoutError and broadcast called exactly once', async () => {
    vi.useFakeTimers();
    try {
      const broadcast = vi.fn(() => new Promise<string>(() => {})); // never resolves
      const p = withTxConfirmation(broadcast, { timeout: 1000 });
      const assertion = expect(p).rejects.toMatchObject({
        name: 'ManifestMCPError',
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
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

  it('observes an abort fired synchronously by an opaque broadcast callback', async () => {
    const abort = new AbortController();
    await expect(
      withTxConfirmation(
        () => {
          abort.abort(new Error('cancelled synchronously'));
          return new Promise<string>(() => {});
        },
        { signal: abort.signal },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      details: { sent: true },
    });
  });

  it('preparation cancellation keeps the final submission checkpoint closed', async () => {
    const abort = new AbortController();
    const broadcast = vi.fn();
    let resume!: () => void;
    const prepared = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const result = withTxExecution(
      async (execution) => {
        await prepared;
        execution.markBroadcast();
        broadcast();
      },
      { signal: abort.signal },
    );
    abort.abort();
    await expect(result).rejects.toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      details: { sent: false },
    });
    resume();
    await prepared;
    expect(broadcast).not.toHaveBeenCalled();
  });
});
