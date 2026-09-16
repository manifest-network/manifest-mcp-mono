import { describe, expect, it, vi } from 'vitest';
import { expectExactDetails } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import {
  type TxExecution,
  withTxConfirmation,
  withTxExecution,
} from './tx-confirmation.js';

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

describe('transaction cancellation evidence snapshots', () => {
  it('retains the first accepted hash and original reason without waiting for the operation', async () => {
    const abort = new AbortController();
    const reason = { source: 'caller' };
    const firstHash = 'A1'.repeat(32);
    let execution!: TxExecution;
    const pending = withTxExecution(
      async (current) => {
        execution = current;
        current.markBroadcast();
        current.onAccepted?.(firstHash);
        current.onAccepted?.('B2'.repeat(32));
        return new Promise<void>(() => {});
      },
      { signal: abort.signal },
    ).catch((error: unknown) => error);

    abort.abort(reason);
    const error = await pending;
    expectExactDetails(error, {
      reason,
      sent: true,
      transactionHash: firstHash,
    });
    expect((error as ManifestMCPError).details?.reason).toBe(reason);
    expect((error as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.OPERATION_CANCELLED,
    );
    execution.onAccepted?.('C3'.repeat(32));
    expectExactDetails(error, {
      reason,
      sent: true,
      transactionHash: firstHash,
    });
  });

  it('ignores acceptance after cancellation, including later checkpoints', async () => {
    const abort = new AbortController();
    const reason = 'stop before acceptance';
    let execution!: TxExecution;
    const pending = withTxExecution(
      async (current) => {
        execution = current;
        current.markBroadcast();
        return new Promise<void>(() => {});
      },
      { signal: abort.signal },
    ).catch((error: unknown) => error);

    abort.abort(reason);
    const error = await pending;
    execution.onAccepted?.('A1'.repeat(32));
    expectExactDetails(error, { reason, sent: true });
    let lateCheckpoint: unknown;
    try {
      execution.checkpoint();
    } catch (caught) {
      lateCheckpoint = caught;
    }
    expectExactDetails(lateCheckpoint, { reason, sent: true });
  });

  it.each([false, true])(
    'native acceptance establishes submission evidence before the marker (later marker: %s)',
    async (markAfterAcceptance) => {
      const abort = new AbortController();
      const hash = 'A1'.repeat(32);
      const pending = withTxExecution(
        async (execution) => {
          execution.onAccepted?.(hash);
          if (markAfterAcceptance) execution.markBroadcast();
          return new Promise<void>(() => {});
        },
        { signal: abort.signal },
      ).catch((error: unknown) => error);
      abort.abort('after observed acceptance');
      expectExactDetails(await pending, {
        reason: 'after observed acceptance',
        sent: true,
        transactionHash: hash,
      });
    },
  );

  it('does not observe acceptance when there is no cancellation boundary', async () => {
    await expect(
      withTxExecution(async (execution) => {
        expect(execution.onAccepted).toBeUndefined();
        execution.markBroadcast();
        return 'normal result';
      }),
    ).resolves.toBe('normal result');
  });
});
