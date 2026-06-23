import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import type { ProgressEvent } from '../types.js';
import {
  cancelledError,
  makeCancellationScope,
  raceAbort,
} from './cancellation.js';

function recorder(): {
  events: ProgressEvent[];
  onProgress: (e: ProgressEvent) => void;
} {
  const events: ProgressEvent[] = [];
  return { events, onProgress: (e) => events.push(e) };
}
const cancelledCount = (events: ProgressEvent[]): number =>
  events.filter((e) => e.kind === 'cancelled').length;

describe('cancelledError', () => {
  it('broadcasts:true is byte-identical to the deployApp pre-broadcast message', () => {
    const err = cancelledError(
      new Error('aborted by caller'),
      'Deployment',
      true,
    );
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect(err.code).toBe(ManifestMCPErrorCode.OPERATION_CANCELLED);
    expect(err.message).toBe(
      'Deployment was cancelled before broadcast (aborted by caller); no transaction was sent.',
    );
  });

  it('broadcasts:false drops the broadcast clause for read-only flows', () => {
    const err = cancelledError(new Error('timeout'), 'Troubleshoot', false);
    expect(err.message).toBe('Troubleshoot was cancelled (timeout).');
  });

  it('stringifies a non-Error reason', () => {
    expect(cancelledError('boom', 'Lease close', true).message).toBe(
      'Lease close was cancelled before broadcast (boom); no transaction was sent.',
    );
  });
});

describe('raceAbort', () => {
  const makeError = (r: unknown) => cancelledError(r, 'Op', true);

  it('rejects with the injected error on an already-aborted signal and swallows the loser', async () => {
    const ac = new AbortController();
    ac.abort(new Error('pre-aborted'));
    let resolveLoser: (v: string) => void = () => {};
    const loser = new Promise<string>((res) => {
      resolveLoser = res;
    });
    await expect(raceAbort(loser, ac.signal, makeError)).rejects.toThrow(
      /Op was cancelled/,
    );
    resolveLoser('late'); // settles after — must not surface an unhandled rejection
  });

  it('rejects on a later abort', async () => {
    const ac = new AbortController();
    const never = new Promise<string>(() => {});
    const raced = raceAbort(never, ac.signal, makeError);
    ac.abort(new Error('mid-flight'));
    await expect(raced).rejects.toThrow(/mid-flight/);
  });

  it('resolves with the winner when the promise settles first', async () => {
    const ac = new AbortController();
    await expect(
      raceAbort(Promise.resolve('ok'), ac.signal, makeError),
    ).resolves.toBe('ok');
  });
});

describe('makeCancellationScope', () => {
  it('throwIfCancelled on a pre-aborted signal throws and emits cancelled exactly once', () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    const { events, onProgress } = recorder();
    const cx = makeCancellationScope({
      opts: { signal: ac.signal },
      onProgress,
      opLabel: 'Op',
      broadcasts: true,
    });
    expect(() => cx.throwIfCancelled()).toThrow(ManifestMCPError);
    expect(() => cx.throwIfCancelled()).toThrow(ManifestMCPError); // 2nd call: no re-emit
    expect(cancelledCount(events)).toBe(1);
  });

  it('no signal → race is a passthrough and throwIfCancelled is a no-op', async () => {
    const { events, onProgress } = recorder();
    const cx = makeCancellationScope({
      opts: {},
      onProgress,
      opLabel: 'Op',
      broadcasts: false,
    });
    expect(cx.signal).toBeUndefined();
    expect(() => cx.throwIfCancelled()).not.toThrow();
    await expect(cx.race(Promise.resolve(42))).resolves.toBe(42);
    expect(events).toHaveLength(0);
  });

  it('race rejects + emits cancelled once when the signal aborts mid-await (loser swallowed)', async () => {
    const ac = new AbortController();
    const { events, onProgress } = recorder();
    const cx = makeCancellationScope({
      opts: { signal: ac.signal },
      onProgress,
      opLabel: 'Op',
      broadcasts: false,
    });
    let rejectLoser: (e: unknown) => void = () => {};
    const loser = new Promise<string>((_res, rej) => {
      rejectLoser = rej;
    });
    const raced = cx.race(loser);
    ac.abort(new Error('mid'));
    await expect(raced).rejects.toThrow(/Op was cancelled/);
    rejectLoser(new Error('late-loser')); // must be swallowed
    await Promise.resolve();
    expect(cancelledCount(events)).toBe(1);
  });

  it('composed timeout: race rejects with OPERATION_CANCELLED after the timer fires', async () => {
    vi.useFakeTimers();
    try {
      const { events, onProgress } = recorder();
      const cx = makeCancellationScope({
        opts: { timeout: 1000 },
        onProgress,
        opLabel: 'Op',
        broadcasts: true,
      });
      const never = new Promise<string>(() => {});
      const assertion = expect(cx.race(never)).rejects.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(cancelledCount(events)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
