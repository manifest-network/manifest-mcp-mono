// Tests for the readiness policy driven through its INJECTED reader — no wire, no `vi.mock`.
//
// `http/fred.test.ts` covers this same loop end-to-end through the published positional
// `pollLeaseUntilReady` and a fetch probe, and those 69 cases are the move's characterization
// suite. This file exists for the cases that are awkward or impossible to reach from that side,
// which is precisely what lifting the loop out of the transport bought (ENG-725/ENG-716).
//
// The Retry-After ceiling below is the concrete example, and it was found by mutation testing
// rather than by reading: deleting `MAX_RETRY_AFTER_HONOURED_MS` from the clamp left all 69
// transport-level tests GREEN. Every one of them uses a short `timeoutMs`, so `deadline - now()`
// always dominated the `Math.min` and the ceiling never bound. It only binds when a provider sends
// a huge `Retry-After` AND the deadline is long — production conditions, not test conditions.
import {
  type FredLeaseStatus,
  LeaseState,
} from '@manifest-network/manifest-mcp-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderApiError } from '../http/provider.js';
import {
  type LeaseStatusReader,
  pollLeaseReadiness,
} from './poll-lease-readiness.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';

type FredStatusLike = {
  readonly state: LeaseState;
  readonly provision_status?: string;
};

/**
 * The loop's only I/O, scripted. The last step repeats forever, so a poll can settle; an `Error`
 * step is thrown rather than returned, which is how a transient blip is modelled.
 */
function reader(steps: ReadonlyArray<FredStatusLike | Error>): {
  read: LeaseStatusReader;
  calls: () => number;
} {
  let n = 0;
  const read: LeaseStatusReader = async () => {
    const step = steps[Math.min(n, steps.length - 1)];
    n += 1;
    if (step instanceof Error) throw step;
    return step as FredLeaseStatus;
  };
  return { read, calls: () => n };
}

const ACTIVE_READY: FredStatusLike = {
  state: LeaseState.LEASE_STATE_ACTIVE,
  provision_status: 'ready',
};
const PENDING: FredStatusLike = { state: LeaseState.LEASE_STATE_PENDING };

const input = { leaseUuid: LEASE_UUID, mintToken: async () => 'tok' };

afterEach(() => {
  vi.useRealTimers();
});

describe('pollLeaseReadiness — the injected reader', () => {
  it('returns the first CONFIRMED-ready status', async () => {
    const { read, calls } = reader([ACTIVE_READY]);

    const out = await pollLeaseReadiness(read, input, { intervalMs: 0 });

    expect(out).toEqual(ACTIVE_READY);
    expect(calls()).toBe(1);
  });

  it('re-mints the auth token on EVERY iteration', async () => {
    // ADR-036 tokens are deterministic, so a reused one is a replay-rejected duplicate.
    const mintToken = vi.fn(async () => 'tok');
    const { read, calls } = reader([PENDING, PENDING, ACTIVE_READY]);

    await pollLeaseReadiness(
      read,
      { leaseUuid: LEASE_UUID, mintToken },
      {
        intervalMs: 0,
      },
    );

    expect(mintToken).toHaveBeenCalledTimes(3);
    expect(calls()).toBe(3);
  });

  it('keeps polling on an UNRECOGNIZED provision_status rather than reporting ready', async () => {
    // ENG-651: readiness is an allowlist. A status this client has never heard of is
    // "not confirmed ready", never "ready".
    const { read, calls } = reader([
      { state: LeaseState.LEASE_STATE_ACTIVE, provision_status: 'quantum' },
      ACTIVE_READY,
    ]);

    const out = await pollLeaseReadiness(read, input, { intervalMs: 0 });

    expect(out).toEqual(ACTIVE_READY);
    expect(calls()).toBe(2);
  });

  it('never counts a VERDICT against the failure budget', async () => {
    // The status read is inside the try; the verdict switch is deliberately outside it, so no
    // budget can swallow a real answer. A terminal state fails fast however large the budget.
    const { read, calls } = reader([{ state: LeaseState.LEASE_STATE_CLOSED }]);

    await expect(
      pollLeaseReadiness(read, input, {
        intervalMs: 0,
        maxConsecutiveFailures: 1000,
      }),
    ).rejects.toThrow(/entered terminal state/);
    expect(calls()).toBe(1);
  });
});

describe('pollLeaseReadiness — Retry-After is honoured but BOUNDED', () => {
  it('caps a hostile Retry-After at the 30s ceiling instead of sleeping for it', async () => {
    // Fred caps its own header at 86400s; honouring that literally would hand a single response
    // the entire budget. Only reachable with a deadline LONGER than the ceiling — which is why
    // the transport-level suite could not catch its removal.
    vi.useFakeTimers();
    const { read, calls } = reader([
      new ProviderApiError(503, 'slow down', {
        kind: 'http',
        retryAfterMs: 86_400_000,
      }),
      ACTIVE_READY,
    ]);

    const pending = pollLeaseReadiness(read, input, {
      timeoutMs: 600_000,
      intervalMs: 1_000,
      maxConsecutiveFailures: 5,
    });

    // Exactly the ceiling. Without the clamp the wait would be the remaining deadline
    // (~600s), so the second read would NOT have happened yet.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls()).toBe(2);

    await expect(pending).resolves.toEqual(ACTIVE_READY);
  });

  it('still bounds the wait by the remaining deadline when that is shorter', async () => {
    vi.useFakeTimers();
    const { read } = reader([
      new ProviderApiError(503, 'slow down', {
        kind: 'http',
        retryAfterMs: 86_400_000,
      }),
    ]);

    const pending = pollLeaseReadiness(read, input, {
      timeoutMs: 5_000,
      intervalMs: 1_000,
      maxConsecutiveFailures: 5,
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(10_000);

    // The deadline, not the ceiling, ends this one — and it ends as `deadline`, not as a
    // provider-unreachable budget exhaustion.
    await expect(pending).resolves.toMatchObject({ reason: 'deadline' });
  });
});
