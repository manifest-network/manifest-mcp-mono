import { LeaseState, logger } from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./provider.js')>();
  return {
    ...actual,
    validateProviderUrl: vi.fn((url: string) => url),
    checkedFetch: vi.fn(),
    parseJsonResponse: vi.fn(),
  };
});

import {
  getLeaseLogs,
  getLeaseStatus,
  MAX_TAIL,
  pollLeaseUntilReady,
  restoreLease,
  TerminalChainStateError,
  updateLease,
} from './fred.js';
import {
  checkedFetch,
  ProviderApiError,
  parseJsonResponse,
} from './provider.js';

const mockCheckedFetch = vi.mocked(checkedFetch);
const mockParseJsonResponse = vi.mocked(parseJsonResponse);

const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_TOKEN = 'test-token';

describe('getLeaseStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches status with auth header and converts state to LeaseState', async () => {
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_ACTIVE' });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockCheckedFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/leases/${LEASE_UUID}/status`),
      expect.objectContaining({
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      }),
      undefined,
      undefined,
    );
  });

  it('returns UNRECOGNIZED for unknown state strings', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'something_unknown' });

    const result = await getLeaseStatus(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    expect(result.state).toBe(LeaseState.UNRECOGNIZED);
  });

  it('preserves all wire fields through conversion', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
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
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 5000);
    const url = mockCheckedFetch.mock.calls[0][0];
    expect(url).toContain(`?tail=${MAX_TAIL}`);
  });

  it('passes tail directly when within limit', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 50);
    const url = mockCheckedFetch.mock.calls[0][0];
    expect(url).toContain('?tail=50');
  });

  it('omits tail query param when not provided', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ logs: {} });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN);
    const url = mockCheckedFetch.mock.calls[0][0];
    expect(url).not.toContain('?tail');
  });
});

describe('pollLeaseUntilReady', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns immediately when state is ACTIVE', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_ACTIVE' });

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
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('returns immediately when ACTIVE and provision_status is ready', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
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
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('keeps polling while ACTIVE but still provisioning, then returns when ready', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
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
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('throws when ACTIVE but the lease is being deprovisioned', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'deprovisioning',
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/provisioning deprovisioning/);
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
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
    mockCheckedFetch.mockResolvedValue({} as Response);

    try {
      mockParseJsonResponse.mockResolvedValue({
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

      mockParseJsonResponse.mockResolvedValue({
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_ACTIVE' });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 1000 },
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('keeps polling while provision_status is the known "unknown" (indeterminate, not ready)', async () => {
    // `unknown` is a real backend ProvisionStatus meaning "not confirmed
    // healthy" (unrecognized container status / state-machine read error) — it
    // must NOT be reported as ready; the poll waits for it to settle.
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_CLOSED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws on REJECTED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_REJECTED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws on EXPIRED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_EXPIRED' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws immediately on UNRECOGNIZED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'SOME_FUTURE_STATE' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/unexpected state/);
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('throws immediately on UNSPECIFIED state', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({
      state: 'LEASE_STATE_UNSPECIFIED',
    });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/unexpected state/);
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('polls until ACTIVE after PENDING', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/poll timed out/);
  });

  it('uses callback function for auth token refresh', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
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
    const firstAuth = mockCheckedFetch.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    const secondAuth = mockCheckedFetch.mock.calls[1][1]?.headers as Record<
      string,
      string
    >;
    expect(firstAuth.Authorization).toBe('Bearer token-1');
    expect(secondAuth.Authorization).toBe('Bearer token-2');
  });

  it('includes last state in timeout error message', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/LEASE_STATE_PENDING/);
  });

  it('aborts immediately with a pre-aborted signal', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      pollLeaseUntilReady(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, {
        intervalMs: 10,
        timeoutMs: 5000,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(mockCheckedFetch).not.toHaveBeenCalled();
  });

  it('aborts during sleep between polls', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

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
    expect(mockCheckedFetch).toHaveBeenCalledOnce();
  });

  it('invokes checkChainState before the provider on each iteration', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

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
    expect(mockCheckedFetch).not.toHaveBeenCalled();
  });

  it('maps closed and expired chain states onto their lease states', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

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
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

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
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

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
    expect(mockCheckedFetch).not.toHaveBeenCalled();
    expect(checkChainState).toHaveBeenCalledTimes(1);
  });

  it('propagates errors thrown by checkChainState', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ state: 'LEASE_STATE_PENDING' });

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
    expect(mockCheckedFetch).not.toHaveBeenCalled();
  });

  it('calls onProgress on each poll iteration', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    let callCount = 0;
    mockParseJsonResponse.mockImplementation(async () => {
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

describe('restoreLease', () => {
  beforeEach(() => vi.clearAllMocks());
  const FROM = '11111111-2222-3333-4444-555555555555';

  it('POSTs {from_lease_uuid} JSON to /restore with Bearer auth and returns status', async () => {
    mockCheckedFetch.mockResolvedValue({} as Response);
    mockParseJsonResponse.mockResolvedValue({ status: 'provisioning' });

    const res = await restoreLease(PROVIDER_URL, LEASE_UUID, FROM, AUTH_TOKEN);

    expect(res.status).toBe('provisioning');
    expect(mockCheckedFetch).toHaveBeenCalledWith(
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
    const body = JSON.parse(
      mockCheckedFetch.mock.calls[0][1]?.body as string,
    ) as { from_lease_uuid: string };
    expect(body).toEqual({ from_lease_uuid: FROM });
  });

  it('propagates a non-2xx ProviderApiError with its status (e.g. 422 demote)', async () => {
    mockCheckedFetch.mockRejectedValue(
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
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ status: 'updated' });

    const payload = new TextEncoder().encode('{"image":"nginx:alpine"}');
    await updateLease(PROVIDER_URL, LEASE_UUID, payload, AUTH_TOKEN);

    expect(mockCheckedFetch).toHaveBeenCalledWith(
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

    const body = JSON.parse(
      mockCheckedFetch.mock.calls[0][1]?.body as string,
    ) as { payload: string };
    const decoded = atob(body.payload);
    expect(decoded).toBe('{"image":"nginx:alpine"}');
  });

  it('handles large payloads without stack overflow', async () => {
    const mockRes = {} as Response;
    mockCheckedFetch.mockResolvedValue(mockRes);
    mockParseJsonResponse.mockResolvedValue({ status: 'updated' });

    // 128KB payload — ensures large payloads are handled correctly
    const large = new Uint8Array(128 * 1024).fill(65); // all 'A'
    await updateLease(PROVIDER_URL, LEASE_UUID, large, AUTH_TOKEN);

    const body = JSON.parse(
      mockCheckedFetch.mock.calls[0][1]?.body as string,
    ) as { payload: string };
    const decoded = atob(body.payload);
    expect(decoded.length).toBe(128 * 1024);
    expect(decoded[0]).toBe('A');
  });
});
