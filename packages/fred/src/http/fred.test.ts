import { LeaseState, logger } from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider.js')>();
  return {
    ...actual,
    validateProviderUrl: vi.fn((url: string) => url),
    fetchJsonChecked: vi.fn(),
  };
});

import {
  DEFAULT_POLL_TIMEOUT_MS,
  getLeaseLogs,
  getLeaseStatus,
  LeaseReadinessUnconfirmedError,
  MAX_TAIL,
  pollLeaseUntilReady,
  restoreLease,
  TerminalChainStateError,
  updateLease,
} from './fred.js';
import { fetchJsonChecked, ProviderApiError } from './provider.js';

// One mock now: fetchJsonChecked performs the fetch AND the body read under a single
// deadline, so the old checkedFetch + parseJsonResponse pair collapsed (ENG-662).
const mockFetchJson = vi.mocked(fetchJsonChecked);

const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_TOKEN = 'test-token';

describe('getLeaseStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches status with auth header and converts state to LeaseState', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_ACTIVE' });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    // NOTE: the `init` bag is matched with objectContaining, so a `signal` landing inside
    // it passes here without being observed. Anything that needs to prove a signal reaches
    // the transport must assert the key positively — this assertion does not cover it.
    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/leases/${LEASE_UUID}/status`),
      expect.objectContaining({
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      }),
      undefined,
      undefined,
    );
  });

  it('returns UNRECOGNIZED for unknown state strings', async () => {
    mockFetchJson.mockResolvedValue({ state: 'something_unknown' });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.UNRECOGNIZED);
  });

  it('preserves all wire fields through conversion', async () => {
    mockFetchJson.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'provisioned',
      last_error: 'timeout',
      fail_count: 3,
      endpoints: { http: 'https://app.example.com' },
    });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('provisioned');
    expect(result.last_error).toBe('timeout');
    expect(result.fail_count).toBe(3);
    expect(result.endpoints).toEqual({ http: 'https://app.example.com' });
  });
});

describe('getLeaseLogs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps tail at MAX_TAIL', async () => {
    mockFetchJson.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 5000);
    const url = mockFetchJson.mock.calls[0][0];
    expect(url).toContain(`?tail=${MAX_TAIL}`);
  });

  it('passes tail directly when within limit', async () => {
    mockFetchJson.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 50);
    const url = mockFetchJson.mock.calls[0][0];
    expect(url).toContain('?tail=50');
  });

  it('omits tail query param when not provided', async () => {
    mockFetchJson.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    const url = mockFetchJson.mock.calls[0][0];
    expect(url).not.toContain('?tail');
  });
});

describe('pollLeaseUntilReady', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns immediately when state is ACTIVE', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_ACTIVE' });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 1000,
      },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('returns immediately when ACTIVE and provision_status is ready', async () => {
    mockFetchJson.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'ready',
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 1000 },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('keeps polling while ACTIVE but still provisioning, then returns when ready', async () => {
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      return {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: callCount < 3 ? 'provisioning' : 'ready',
      };
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 5000 },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    expect(callCount).toBe(3);
  });

  it('keeps polling through the transient failing window until ready', async () => {
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      return {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: callCount < 2 ? 'failing' : 'ready',
      };
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 5000 },
    );
    expect(result.provision_status).toBe('ready');
    expect(callCount).toBe(2);
  });

  // PRE-ENG-508 fallback. Keep this fixture on the deprecated `last_error`
  // shape and this assertion byte-identical: it is the proof that a provider
  // which has not yet upgraded still yields a useful diagnosis (ENG-638). The
  // post-ENG-508 reason/message cases live in fred-failure-wire.test.ts, which
  // runs through the real parse path instead of the mocks above.
  it('throws when ACTIVE but provisioning failed, surfacing last_error', async () => {
    mockFetchJson.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'failed',
      last_error: 'OOMKilled',
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/provisioning failed: OOMKilled/);
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('throws when ACTIVE but the lease is being deprovisioned', async () => {
    mockFetchJson.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'deprovisioning',
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/provisioning deprovisioning/);
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('keeps polling on a genuinely-unrecognized (future) provision_status — readiness is an allowlist', async () => {
    // ENG-651 REVERSES the previous expectation here, which was that an unrecognized status is
    // "settled" and returns as ready. Two arguments retired it.
    //
    // First, it was internally inconsistent with the test immediately below: the backend's OWN
    // `unknown` ("I cannot tell") correctly keeps polling, while a status the CLIENT cannot
    // recognize was luckier and got reported as a healthy deploy. There is no reading of
    // forward-compatibility under which the client's ignorance is better evidence of health than
    // the server's own admission of doubt.
    //
    // Second, it cost us a real bug: Fred's `retained` — the backend tore the deployment down but
    // kept its volumes — is in neither set, so a closed, soft-deleted, billing-dead lease returned
    // here as ready. Forward-compat means never FAILING on an unknown value (we still carry it
    // through untouched); it never meant treating one as success.
    //
    // Not hanging the poll is still satisfied: the caller's deadline bounds it, and the timeout
    // message names the status, so an unmodelled value is diagnosable instead of silent.
    mockFetchJson.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'some_future_status',
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/provision_status: some_future_status/);
  });

  it('warns about a status it does not model, but NOT about `retained`, which it does', async () => {
    // The audit signal for the fail-closed default has to stay meaningful: it must fire for a value
    // the client has no model of, and stay silent for one it handles deliberately. If `retained`
    // warned, "unrecognized provision_status" would be a lie about the single most likely value to
    // reach this branch, and the log would train operators to ignore it. (ENG-651)
    const warnLines: string[] = [];
    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation((m: unknown) => {
        warnLines.push(String(m));
      });

    try {
      mockFetchJson.mockResolvedValue({
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'retained',
      });
      await expect(
        pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
          intervalMs: 10,
          timeoutMs: 50,
        }),
      ).rejects.toThrow(/provision_status: retained/);
      expect(warnLines.filter((l) => l.includes('Unrecognized'))).toEqual([]);

      mockFetchJson.mockResolvedValue({
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'some_unmodelled_status',
      });
      await expect(
        pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
          intervalMs: 10,
          timeoutMs: 50,
        }),
      ).rejects.toThrow(/timed out/);
      const unrecognized = warnLines.filter((l) => l.includes('Unrecognized'));
      expect(unrecognized).toHaveLength(1); // warn-once, despite several polls
      expect(unrecognized[0]).toContain('some_unmodelled_status');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still returns immediately when provision_status is ABSENT (a provider that never populates it)', async () => {
    // The absent field is NOT an unrecognized value — it is a provider that does not report
    // provisioning at all, and gating on it would strand every such lease. Unchanged by ENG-651.
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_ACTIVE' });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 1000 },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('keeps polling while provision_status is the known "unknown" (indeterminate, not ready)', async () => {
    // `unknown` is a real backend ProvisionStatus meaning "not confirmed
    // healthy" (unrecognized container status / state-machine read error) — it
    // must NOT be reported as ready; the poll waits for it to settle.
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      return {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: callCount < 2 ? 'unknown' : 'ready',
      };
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 5000 },
    );
    expect(result.provision_status).toBe('ready');
    expect(callCount).toBe(2);
  });

  it('includes provision_status in the timeout error when stuck provisioning', async () => {
    mockFetchJson.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'provisioning',
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/provision_status: provisioning/);
  });

  it('throws on CLOSED state', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_CLOSED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws on REJECTED state', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_REJECTED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws on EXPIRED state', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_EXPIRED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws immediately on UNRECOGNIZED state', async () => {
    mockFetchJson.mockResolvedValue({ state: 'SOME_FUTURE_STATE' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/unexpected state/);
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('throws immediately on UNSPECIFIED state', async () => {
    mockFetchJson.mockResolvedValue({
      state: 'LEASE_STATE_UNSPECIFIED',
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/unexpected state/);
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('polls until ACTIVE after PENDING', async () => {
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      return {
        state: callCount < 3 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE',
      };
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 5000,
      },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(callCount).toBe(3);
  });

  it('times out if never active', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/poll timed out/);
  });

  it('uses callback function for auth token refresh', async () => {
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      return {
        state: callCount < 2 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE',
      };
    });

    const tokenFn = vi
      .fn()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');

    await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, tokenFn, {
      intervalMs: 10,
      timeoutMs: 5000,
    });

    expect(tokenFn).toHaveBeenCalledTimes(2);
    // Verify different tokens were used in successive calls
    const firstAuth = mockFetchJson.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    const secondAuth = mockFetchJson.mock.calls[1][1]?.headers as Record<
      string,
      string
    >;
    expect(firstAuth.Authorization).toBe('Bearer token-1');
    expect(secondAuth.Authorization).toBe('Bearer token-2');
  });

  it('includes last state in timeout error message', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/LEASE_STATE_PENDING/);
  });

  it('aborts immediately with a pre-aborted signal', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('aborts during sleep between polls', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const controller = new AbortController();
    // Abort after a short delay (during the sleep interval)
    setTimeout(() => controller.abort(new Error('user cancelled')), 30);

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 5000,
        timeoutMs: 30000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/user cancelled/);
    // Should have polled once, then been aborted during sleep
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('invokes checkChainState before the provider on each iteration', async () => {
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      return {
        state: callCount < 3 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE',
      };
    });

    const checkChainState = vi.fn().mockResolvedValue(null);
    await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 10,
      timeoutMs: 5000,
      checkChainState,
    });

    expect(checkChainState).toHaveBeenCalledTimes(3);
  });

  it('throws TerminalChainStateError with typed chainState + leaseUuid fields', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const checkChainState = vi.fn().mockResolvedValue({ state: 'rejected' });

    let caught: unknown;
    try {
      await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        checkChainState,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TerminalChainStateError);
    // Backward compat: still an instance of ProviderApiError.
    expect(caught).toBeInstanceOf(ProviderApiError);
    expect((caught as TerminalChainStateError).chainState).toBe('rejected');
    expect((caught as TerminalChainStateError).leaseUuid).toBe(LEASE_UUID);
    expect((caught as TerminalChainStateError).name).toBe(
      'TerminalChainStateError',
    );
    expect((caught as TerminalChainStateError).message).toMatch(
      /LEASE_STATE_REJECTED on chain/,
    );
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('maps closed and expired chain states onto their lease states', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        checkChainState: () => Promise.resolve({ state: 'closed' }),
      }),
    ).rejects.toThrow(/LEASE_STATE_CLOSED on chain/);

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        checkChainState: () => Promise.resolve({ state: 'expired' }),
      }),
    ).rejects.toThrow(/LEASE_STATE_EXPIRED on chain/);
  });

  it('continues polling while checkChainState returns null', async () => {
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      return {
        state: callCount < 2 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE',
      };
    });

    const checkChainState = vi.fn().mockResolvedValue(null);
    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 5000,
        checkChainState,
      },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(checkChainState).toHaveBeenCalledTimes(2);
  });

  it('abortSignal takes precedence over a terminal chainState in the same iteration', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const controller = new AbortController();
    controller.abort(new Error('aborted before iteration'));
    const checkChainState = vi.fn().mockResolvedValue({ state: 'rejected' });

    // With a pre-aborted signal, the top-of-loop throwIfAborted fires before
    // checkChainState is ever called. Locks in the ordering.
    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        abortSignal: controller.signal,
        checkChainState,
      }),
    ).rejects.toThrow(/aborted before iteration/);
    expect(checkChainState).not.toHaveBeenCalled();
  });

  it('honors abortSignal aborted while checkChainState is awaiting', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const controller = new AbortController();
    const checkChainState = vi.fn(async () => {
      // Simulate a slow chain RPC; abort mid-await.
      await new Promise((r) => setTimeout(r, 20));
      controller.abort(new Error('cancelled during chain check'));
      await new Promise((r) => setTimeout(r, 5));
      return null;
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        abortSignal: controller.signal,
        checkChainState,
      }),
    ).rejects.toThrow(/cancelled during chain check/);

    // Provider status must not be fetched after the signal aborted.
    expect(mockFetchJson).not.toHaveBeenCalled();
    expect(checkChainState).toHaveBeenCalledTimes(1);
  });

  it('propagates errors thrown by checkChainState', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const checkChainState = vi
      .fn()
      .mockRejectedValue(new Error('chain RPC down'));
    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        checkChainState,
      }),
    ).rejects.toThrow(/chain RPC down/);
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('calls onProgress on each poll iteration', async () => {
    let callCount = 0;
    mockFetchJson.mockImplementation(async () => {
      callCount++;
      return {
        state: callCount < 3 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE',
      };
    });

    const onProgress = vi.fn();
    await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 10,
      timeoutMs: 5000,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      state: LeaseState.LEASE_STATE_PENDING,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      state: LeaseState.LEASE_STATE_PENDING,
    });
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
  });
});

/**
 * ENG-661 / ENG-479. Before this, the in-loop status read had no try/catch at
 * all: a single 502 from a provider's ingress, one DNS blip, or the 404 window
 * right after create-lease while the provider ingests the new lease aborted the
 * whole deploy — ~40 chances to fail per deploy against a third-party endpoint.
 *
 * The budget covers the status READ and nothing else. The "never swallowed"
 * block below is the load-bearing half: if a future edit widens the try to
 * include the state switch, a genuinely failed deployment would be polled
 * silently until the deadline instead of failing fast, and every other test in
 * this file would still pass.
 */
describe('pollLeaseUntilReady — transient-failure budget', () => {
  beforeEach(() => vi.clearAllMocks());

  /** Drive the poll from a script of per-iteration outcomes. */
  function scriptReads(steps: Array<{ throw?: unknown; state?: string }>) {
    let i = 0;
    mockFetchJson.mockImplementation(async () => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step?.throw !== undefined) throw step.throw;
      return { state: step?.state ?? 'LEASE_STATE_PENDING' };
    });
  }

  const transient = (status = 502) =>
    new ProviderApiError(status, 'bad gateway', { kind: 'http' });

  it('tolerates failures up to the budget and then succeeds', async () => {
    scriptReads([
      { throw: transient() },
      { throw: transient() },
      { state: 'LEASE_STATE_ACTIVE' },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 3 },
    );

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockFetchJson).toHaveBeenCalledTimes(3);
  });

  it('resets the counter on a successful read, so the budget is a BURST tolerance', async () => {
    // 5 failures total, never 4 in a row: with a cumulative counter this would
    // throw; with a consecutive one it resolves.
    scriptReads([
      { throw: transient() },
      { throw: transient() },
      { state: 'LEASE_STATE_PENDING' },
      { throw: transient() },
      { throw: transient() },
      { throw: transient() },
      { state: 'LEASE_STATE_ACTIVE' },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 3 },
    );

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockFetchJson).toHaveBeenCalledTimes(7);
  });

  it('gives up past the budget with reason "provider_unreachable", naming the last error', async () => {
    scriptReads([{ throw: transient(503) }]);

    const err = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 2 },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LeaseReadinessUnconfirmedError);
    const unconfirmed = err as LeaseReadinessUnconfirmedError;
    expect(unconfirmed.reason).toBe('provider_unreachable');
    expect(unconfirmed.consecutiveFailures).toBe(3);
    expect(unconfirmed.message).toContain('bad gateway');
    // The honest verdict: we never learned anything, so the caller must not
    // read this as "the deployment failed".
    expect(unconfirmed.message).toContain('NOT a reported failure');
    expect(unconfirmed.cause).toBeInstanceOf(ProviderApiError);
    expect(mockFetchJson).toHaveBeenCalledTimes(3);
  });

  it('maxConsecutiveFailures: 0 restores the pre-ENG-661 fail-on-first-blip behaviour', async () => {
    scriptReads([{ throw: transient() }]);

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 1,
        timeoutMs: 5000,
        maxConsecutiveFailures: 0,
      }),
    ).rejects.toBeInstanceOf(LeaseReadinessUnconfirmedError);
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });

  it('defaults to tolerating 3 consecutive failures', async () => {
    scriptReads([
      { throw: transient() },
      { throw: transient() },
      { throw: transient() },
      { state: 'LEASE_STATE_ACTIVE' },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000 },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
  });

  /**
   * The other half of ENG-703: an abort raised BELOW us — an injected fetch running its
   * own, shorter deadline — reaches this loop as a `kind: 'network'` ProviderApiError and
   * IS tolerated. Before the fix it arrived as `throw undefined` and failed the deploy on
   * the first occurrence; nothing of ours aborted, so it is a transport blip like any
   * other and stays bounded by this budget.
   */
  it('tolerates an abort raised below the transport, tagged network', async () => {
    scriptReads([
      {
        throw: new ProviderApiError(
          0,
          'Network request to https://p.example failed: The operation was aborted',
          { kind: 'network' },
        ),
      },
      { state: 'LEASE_STATE_ACTIVE' },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 3 },
    );

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  describe('never swallowed', () => {
    it.each([
      ['a 401 (auth is not a blip)', 401],
      ['a 403', 403],
      ['a 400', 400],
    ])('propagates %s on the FIRST iteration', async (_label, status) => {
      scriptReads([
        { throw: new ProviderApiError(status, 'nope', { kind: 'http' }) },
      ]);

      const err = await pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 5 },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProviderApiError);
      expect(err).not.toBeInstanceOf(LeaseReadinessUnconfirmedError);
      expect((err as ProviderApiError).status).toBe(status);
      expect(mockFetchJson).toHaveBeenCalledOnce();
    });

    it('propagates an SSRF/URL rejection immediately (it will never change)', async () => {
      scriptReads([
        {
          throw: new ProviderApiError(0, 'Provider URL is not allowed: …', {
            kind: 'invalid_url',
          }),
        },
      ]);

      await expect(
        pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
          intervalMs: 1,
          timeoutMs: 5000,
          maxConsecutiveFailures: 5,
        }),
      ).rejects.toThrow(/not allowed/);
      expect(mockFetchJson).toHaveBeenCalledOnce();
    });

    it('propagates a non-ProviderApiError (a bug is not a blip)', async () => {
      scriptReads([{ throw: new TypeError('reading of undefined') }]);

      await expect(
        pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
          intervalMs: 1,
          timeoutMs: 5000,
          maxConsecutiveFailures: 5,
        }),
      ).rejects.toThrow(TypeError);
      expect(mockFetchJson).toHaveBeenCalledOnce();
    });

    /**
     * The retryability half of ENG-703, pinned at the ONE production consumer of
     * `isTransientProviderError`. `checkedFetch` surfaces a cancel as the caller's own
     * abort reason — over MCP that is `notification.params.reason`, a plain STRING — and
     * leaving it unwrapped is what makes it structurally incapable of being tolerated
     * here. No `abortSignal` is passed on purpose: the VALUE alone must fail fast, so the
     * guarantee does not depend on the signal gate one line above it.
     */
    it('propagates a cancellation value, whatever shape it arrives in', async () => {
      scriptReads([{ throw: 'user pressed stop' }]);

      const err = await pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 5 },
      ).catch((e: unknown) => e);

      expect(err).toBe('user pressed stop');
      expect(mockFetchJson).toHaveBeenCalledOnce();
    });

    it('a PROVISION_FAILED verdict still fails fast, however large the budget', async () => {
      mockFetchJson.mockResolvedValue({
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'failed',
      });

      await expect(
        pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
          intervalMs: 1,
          timeoutMs: 5000,
          maxConsecutiveFailures: 99,
        }),
      ).rejects.toThrow(/provisioning failed/);
      expect(mockFetchJson).toHaveBeenCalledOnce();
    });

    it('a terminal lease state still fails fast, however large the budget', async () => {
      mockFetchJson.mockResolvedValue({
        state: 'LEASE_STATE_CLOSED',
      });

      await expect(
        pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
          intervalMs: 1,
          timeoutMs: 5000,
          maxConsecutiveFailures: 99,
        }),
      ).rejects.toThrow(/terminal state/);
      expect(mockFetchJson).toHaveBeenCalledOnce();
    });

    it('an abort racing a transient failure surfaces the abort, not the tolerance', async () => {
      const controller = new AbortController();
      let calls = 0;
      mockFetchJson.mockImplementation(async () => {
        calls += 1;
        controller.abort(new Error('user cancelled'));
        throw transient();
      });

      const startedAt = Date.now();
      // A 5s interval means a "tolerate first, notice the abort later" bug
      // blows vitest's 5s test timeout — the failure mode we want.
      await expect(
        pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
          intervalMs: 5_000,
          timeoutMs: 60_000,
          maxConsecutiveFailures: 5,
          abortSignal: controller.signal,
        }),
      ).rejects.toThrow(/user cancelled/);

      expect(calls).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it('an abort DURING the post-failure backoff cancels the wait', async () => {
      const controller = new AbortController();
      mockFetchJson.mockImplementation(async () => {
        throw transient();
      });
      setTimeout(
        () => controller.abort(new Error('cancelled mid-backoff')),
        20,
      );

      const startedAt = Date.now();
      await expect(
        pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
          intervalMs: 5_000,
          timeoutMs: 60_000,
          maxConsecutiveFailures: 5,
          abortSignal: controller.signal,
        }),
      ).rejects.toThrow(/cancelled mid-backoff/);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });
  });

  /**
   * ENG-479's motivating case: right after create-lease the provider may still
   * be ingesting the lease, so `/status` 404s for a beat. A 404 is NOT globally
   * transient — `isTransientProviderError` rejects it, and it stays a hard error
   * on every other provider call — so the tolerance is scoped to this loop.
   */
  it('tolerates the 404 ingestion window right after create-lease', async () => {
    scriptReads([
      { throw: new ProviderApiError(404, 'lease not found', { kind: 'http' }) },
      { throw: new ProviderApiError(404, 'lease not found', { kind: 'http' }) },
      { state: 'LEASE_STATE_ACTIVE' },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 3 },
    );

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockFetchJson).toHaveBeenCalledTimes(3);
  });

  it('still gives up on a 404 that never resolves — the tolerance is bounded', async () => {
    scriptReads([
      { throw: new ProviderApiError(404, 'lease not found', { kind: 'http' }) },
    ]);

    const err = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 2 },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LeaseReadinessUnconfirmedError);
    expect((err as LeaseReadinessUnconfirmedError).reason).toBe(
      'provider_unreachable',
    );
    expect(mockFetchJson).toHaveBeenCalledTimes(3);
  });

  it('honours a provider Retry-After instead of the poll interval', async () => {
    scriptReads([
      {
        throw: new ProviderApiError(429, 'rate limited', {
          kind: 'http',
          retryAfterMs: 60,
        }),
      },
      { state: 'LEASE_STATE_ACTIVE' },
    ]);

    const startedAt = Date.now();
    await pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
      intervalMs: 1,
      timeoutMs: 5_000,
    });

    // Waited the header's 60ms rather than the 1ms interval.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });

  it('never sleeps a Retry-After past the deadline', async () => {
    scriptReads([
      {
        throw: new ProviderApiError(503, 'unavailable', {
          kind: 'http',
          // Fred caps its own header at 86400s; honouring that literally would
          // park the poll for a day.
          retryAfterMs: 86_400_000,
        }),
      },
    ]);

    const startedAt = Date.now();
    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 1,
        timeoutMs: 40,
        maxConsecutiveFailures: 99,
      }),
    ).rejects.toBeInstanceOf(LeaseReadinessUnconfirmedError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('pollLeaseUntilReady — deadline (ENG-661)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to the provider's own 10-minute provisioning allowance", () => {
    // Fred's docker backend: ProvisionTimeout 10m, of which ImagePullTimeout is
    // 5m. The old 120s default gave up ~5x early on a healthy cold start.
    expect(DEFAULT_POLL_TIMEOUT_MS).toBe(10 * 60 * 1_000);
  });

  it('applies DEFAULT_POLL_TIMEOUT_MS when no timeoutMs is given', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

      const settled = pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          // Explicit, large interval: only the DEADLINE is under test, and the
          // 3s default would mean ~200 mock reads.
          intervalMs: 60_000,
        },
      );
      const assertion = expect(settled).rejects.toThrow(
        /poll timed out after 600000ms/,
      );

      await vi.advanceTimersByTimeAsync(599_000);
      await vi.advanceTimersByTimeAsync(61_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the deadline as unconfirmed, not failed, with the last state seen', async () => {
    mockFetchJson.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'provisioning',
    });

    const err = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 50,
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LeaseReadinessUnconfirmedError);
    const unconfirmed = err as LeaseReadinessUnconfirmedError;
    expect(unconfirmed.reason).toBe('deadline');
    expect(unconfirmed.message).toContain('NOT a reported failure');
    expect(unconfirmed.message).toContain('app_status');
    expect(unconfirmed.details).toMatchObject({
      lease_uuid: LEASE_UUID,
      reason: 'deadline',
      last_state: 'LEASE_STATE_ACTIVE',
      last_provision_status: 'provisioning',
      timeout_ms: 50,
    });
  });

  it('is a ProviderApiError, brand included, so existing catchers keep working', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const err = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 30,
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderApiError);
    expect(ProviderApiError.isProviderApiError(err)).toBe(true);
    expect((err as ProviderApiError).status).toBe(0);
    expect((err as ProviderApiError).kind).toBe('poll');
    expect((err as Error).name).toBe('LeaseReadinessUnconfirmedError');
  });

  it('withContext preserves the stack and adds provider identity', async () => {
    mockFetchJson.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const err = (await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 30,
      },
    ).catch((e: unknown) => e)) as LeaseReadinessUnconfirmedError;

    const enriched = err.withContext({
      lease_uuid: LEASE_UUID,
      providerUuid: 'provider-1',
      providerUrl: PROVIDER_URL,
    });
    expect(enriched.details.provider_uuid).toBe('provider-1');
    expect(enriched.details.provider_url).toBe(PROVIDER_URL);
    expect(enriched.reason).toBe('deadline');
    expect(enriched.stack).toBe(err.stack);
  });
});

describe('restoreLease', () => {
  beforeEach(() => vi.clearAllMocks());
  const FROM = '11111111-2222-3333-4444-555555555555';

  it('POSTs {from_lease_uuid} JSON to /restore with Bearer auth and returns status', async () => {
    mockFetchJson.mockResolvedValue({ status: 'provisioning' });

    const res = await restoreLease(PROVIDER_URL, LEASE_UUID, FROM, AUTH_TOKEN);

    expect(res.status).toBe('provisioning');
    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/leases/${LEASE_UUID}/restore`),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        }),
      }),
      undefined,
      undefined,
    );
    const body = JSON.parse(mockFetchJson.mock.calls[0][1]?.body as string) as {
      from_lease_uuid: string;
    };
    expect(body).toEqual({ from_lease_uuid: FROM });
  });

  it('propagates a non-2xx ProviderApiError with its status (e.g. 422 demote)', async () => {
    mockFetchJson.mockRejectedValue(
      new ProviderApiError(
        422,
        'retained data exceeds the requested smaller tier',
      ),
    );
    await expect(
      restoreLease(PROVIDER_URL, LEASE_UUID, FROM, AUTH_TOKEN),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('updateLease', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends JSON body with base64-encoded payload', async () => {
    mockFetchJson.mockResolvedValue({ status: 'updated' });

    const payload = new TextEncoder().encode('{"image":"nginx:alpine"}');
    await updateLease(PROVIDER_URL, LEASE_UUID, payload, AUTH_TOKEN);

    expect(mockFetchJson).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/leases/${LEASE_UUID}/update`),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        }),
      }),
      undefined,
      undefined,
    );

    const body = JSON.parse(mockFetchJson.mock.calls[0][1]?.body as string) as {
      payload: string;
    };
    const decoded = atob(body.payload);
    expect(decoded).toBe('{"image":"nginx:alpine"}');
  });

  it('handles large payloads without stack overflow', async () => {
    mockFetchJson.mockResolvedValue({ status: 'updated' });

    // 128KB payload — ensures large payloads are handled correctly
    const large = new Uint8Array(128 * 1024).fill(65); // all 'A'
    await updateLease(PROVIDER_URL, LEASE_UUID, large, AUTH_TOKEN);

    const body = JSON.parse(mockFetchJson.mock.calls[0][1]?.body as string) as {
      payload: string;
    };
    const decoded = atob(body.payload);
    expect(decoded.length).toBe(128 * 1024);
    expect(decoded[0]).toBe('A');
  });
});
