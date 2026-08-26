// This file mocks NOTHING. Every case below drives the real adapter through an injected
// `fetchFn` and asserts on what reached the wire.
//
// It used to partial-mock `./provider.js`, replacing only `validateProviderUrl` (identity)
// and `fetchJsonChecked`, with everything else arriving via `...actual`. Vitest does not
// rewrite intra-module references, so any function inside provider.ts that calls
// `fetchJsonChecked` internally reaches provider.ts's own module-local binding, which such a
// mock never touches — and provider.ts already has three of those (`getProviderHealth`,
// `getLeaseConnectionInfo`, `uploadLeaseData`). The day `fred.ts` routed through one of
// them, `mockFetchJson` would record nothing, the assertions would quietly stop asserting,
// and — `validateProviderUrl` being mocked to identity — the call would fall through to a
// real outbound request from a unit test. That hazard killed one of ENG-696's candidate
// cancellation designs outright (its C9), and would kill any design that adds a layer inside
// provider.ts. (ENG-705)
//
// The probe sits at `doFetch` (provider.ts:608), BELOW every layer of provider.ts, so
// nothing provider.ts does internally can escape it. This is the argument
// `fred-failure-wire.test.ts` already makes for the failure path — "don't mock what you
// don't own", the gap that let Fred's ENG-508 wire change stay invisible to CI (ENG-638) —
// applied to the whole file. As a bonus the real `validateProviderUrl`, `checkedFetch`,
// `readBodyCapped`, `classifyTransportError`, `classifyBodyError` and the JSON parse now run
// on every assertion here, so a fixture proves behaviour rather than proving that a `vi.fn`
// returned what it was told to.
//
// The probe itself now lives in `@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js`
// — promoted there in ENG-725 when a second file needed it, to the destination and for the reason
// its own JSDoc had specified. The cases below are unchanged by that move.
import {
  type FredLeaseStatus,
  LeaseState,
  logger,
} from '@manifest-network/manifest-mcp-core';
import {
  type FetchProbe,
  fetchProbe,
  type ProbeStep,
} from '@manifest-network/manifest-mcp-core/__test-utils__/fetch-probe.js';
import { describe, expect, it, vi } from 'vitest';
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
import { ProviderApiError } from './provider.js';

const PROVIDER_URL = 'https://provider.example.com';
const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const AUTH_TOKEN = 'test-token';
const TENANT = 'manifest1abc';

function leaseLogs(logs: Record<string, unknown> = {}) {
  return {
    lease_uuid: LEASE_UUID,
    tenant: TENANT,
    provider_uuid: 'prov-1',
    logs,
  };
}

/** A lease still coming up — the commonest wire fixture in this file. */
const PENDING_STEP = { json: { state: 'LEASE_STATE_PENDING' } } as const;

describe('getLeaseStatus', () => {
  it('fetches status with auth header and converts state to LeaseState', async () => {
    const probe = fetchProbe({
      json: { state: 'LEASE_STATE_ACTIVE' },
    });

    const result = await getLeaseStatus(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    // Asserted at the WIRE, so no layer of provider.ts can be skipped and nothing can ride
    // along unobserved. The old assertion ended in two literal `undefined`s — ENG-706 arity
    // anchors on `fetchJsonChecked`, which is no longer the thing being observed. The
    // `Object.keys` anchor below is their successor: it counts slots from the START, so an
    // appended field cannot shift it, and unlike `objectContaining` it cannot let a key
    // through unnoticed.
    expect(probe.calls).toHaveLength(1);
    const { url, init } = probe.calls[0];
    // The REAL validateProviderUrl ran, so the whole URL is assertable, not a substring.
    expect(url).toBe(`${PROVIDER_URL}/v1/leases/${LEASE_UUID}/status`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${AUTH_TOKEN}` });
    // ENG-696 C9: assert the signal POSITIVELY. See `describe('the wire seam')` below.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init)).toEqual(['headers', 'signal']);
  });

  it('returns UNRECOGNIZED for unknown state strings', async () => {
    const probe = fetchProbe({ json: { state: 'something_unknown' } });

    const result = await getLeaseStatus(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.UNRECOGNIZED);
  });

  it('preserves all wire fields through conversion', async () => {
    // A genuine round trip now: JSON.stringify -> real stream read -> real JSON.parse.
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'provisioned',
        last_error: 'timeout',
        fail_count: 3,
        endpoints: { http: 'https://app.example.com' },
      },
    });

    const result = await getLeaseStatus(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('provisioned');
    expect(result.last_error).toBe('timeout');
    expect(result.fail_count).toBe(3);
    expect(result.endpoints).toEqual({ http: 'https://app.example.com' });
  });

  it('rejects syntactically valid JSON with an off-contract required field', async () => {
    const probe = fetchProbe({ json: { state: 3 } });

    const err = await getLeaseStatus(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      probe.fetch,
    ).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(ProviderApiError);
    expect(err).toMatchObject({ status: 200, kind: 'invalid_response' });
    expect((err as Error).message).toContain('state');
  });

  it('drops malformed optional fields while preserving forward-compatible unknown fields', async () => {
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        fail_count: 'many',
        future_capability: { enabled: true },
      },
    });

    const result = await getLeaseStatus(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      probe.fetch,
    );

    expect(result.fail_count).toBeUndefined();
    expect(
      (result as FredLeaseStatus & Record<string, unknown>).future_capability,
    ).toEqual({ enabled: true });
  });
});

describe('getLeaseLogs', () => {
  it('caps tail at MAX_TAIL', async () => {
    const probe = fetchProbe({ json: leaseLogs() });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 5000, probe.fetch);
    expect(probe.calls[0].url).toContain(`?tail=${MAX_TAIL}`);
  });

  it('passes tail directly when within limit', async () => {
    const probe = fetchProbe({ json: leaseLogs() });

    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 50, probe.fetch);
    expect(probe.calls[0].url).toContain('?tail=50');
  });

  it('omits tail query param when not provided', async () => {
    const probe = fetchProbe({ json: leaseLogs() });

    await getLeaseLogs(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      undefined,
      probe.fetch,
    );
    expect(probe.calls[0].url).not.toContain('?tail');
  });
});

describe('pollLeaseUntilReady', () => {
  it('returns immediately when state is ACTIVE', async () => {
    const probe = fetchProbe({
      json: { state: 'LEASE_STATE_ACTIVE' },
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 1000,
      },
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(probe.calls).toHaveLength(1);
  });

  it('returns immediately when ACTIVE and provision_status is ready', async () => {
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'ready',
      },
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 1000 },
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    expect(probe.calls).toHaveLength(1);
  });

  it('keeps polling while ACTIVE but still provisioning, then returns when ready', async () => {
    const probe = fetchProbe((_call, n) => ({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: n < 2 ? 'provisioning' : 'ready',
      },
    }));

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 5000 },
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.provision_status).toBe('ready');
    expect(probe.calls).toHaveLength(3);
  });

  it('keeps polling through the transient failing window until ready', async () => {
    const probe = fetchProbe((_call, n) => ({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: n < 1 ? 'failing' : 'ready',
      },
    }));

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 5000 },
      probe.fetch,
    );
    expect(result.provision_status).toBe('ready');
    expect(probe.calls).toHaveLength(2);
  });

  // PRE-ENG-508 fallback. Keep this fixture on the deprecated `last_error`
  // shape and this assertion byte-identical: it is the proof that a provider
  // which has not yet upgraded still yields a useful diagnosis (ENG-638). The
  // post-ENG-508 reason/message cases live in fred-failure-wire.test.ts, which
  // additionally pins BOTH provider eras from one call site.
  it('throws when ACTIVE but provisioning failed, surfacing last_error', async () => {
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'failed',
        last_error: 'OOMKilled',
      },
    });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/provisioning failed: OOMKilled/);
    expect(probe.calls).toHaveLength(1);
  });

  it('throws when ACTIVE but the lease is being deprovisioned', async () => {
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'deprovisioning',
      },
    });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/provisioning deprovisioning/);
    expect(probe.calls).toHaveLength(1);
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
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'some_future_status',
      },
    });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 50,
        },
        probe.fetch,
      ),
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
      const retained = fetchProbe({
        json: {
          state: 'LEASE_STATE_ACTIVE',
          provision_status: 'retained',
        },
      });
      await expect(
        pollLeaseUntilReady(
          PROVIDER_URL,
          LEASE_UUID,
          AUTH_TOKEN,
          { intervalMs: 10, timeoutMs: 50 },
          retained.fetch,
        ),
      ).rejects.toThrow(/provision_status: retained/);
      expect(warnLines.filter((l) => l.includes('Unrecognized'))).toEqual([]);

      const unmodelled = fetchProbe({
        json: {
          state: 'LEASE_STATE_ACTIVE',
          provision_status: 'some_unmodelled_status',
        },
      });
      await expect(
        pollLeaseUntilReady(
          PROVIDER_URL,
          LEASE_UUID,
          AUTH_TOKEN,
          { intervalMs: 10, timeoutMs: 50 },
          unmodelled.fetch,
        ),
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
    const probe = fetchProbe({
      json: { state: 'LEASE_STATE_ACTIVE' },
    });

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 1000 },
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(probe.calls).toHaveLength(1);
  });

  it('keeps polling while provision_status is the known "unknown" (indeterminate, not ready)', async () => {
    // `unknown` is a real backend ProvisionStatus meaning "not confirmed
    // healthy" (unrecognized container status / state-machine read error) — it
    // must NOT be reported as ready; the poll waits for it to settle.
    const probe = fetchProbe((_call, n) => ({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: n < 1 ? 'unknown' : 'ready',
      },
    }));

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 5000 },
      probe.fetch,
    );
    expect(result.provision_status).toBe('ready');
    expect(probe.calls).toHaveLength(2);
  });

  it('includes provision_status in the timeout error when stuck provisioning', async () => {
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'provisioning',
      },
    });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 50,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/provision_status: provisioning/);
  });

  it('throws on CLOSED state', async () => {
    const probe = fetchProbe({ json: { state: 'LEASE_STATE_CLOSED' } });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 1000,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws on REJECTED state', async () => {
    const probe = fetchProbe({ json: { state: 'LEASE_STATE_REJECTED' } });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 1000,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws on EXPIRED state', async () => {
    const probe = fetchProbe({ json: { state: 'LEASE_STATE_EXPIRED' } });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 1000,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/terminal state/);
  });

  it('throws immediately on UNRECOGNIZED state', async () => {
    const probe = fetchProbe({ json: { state: 'SOME_FUTURE_STATE' } });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/unexpected state/);
    expect(probe.calls).toHaveLength(1);
  });

  it('throws immediately on UNSPECIFIED state', async () => {
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_UNSPECIFIED',
      },
    });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/unexpected state/);
    expect(probe.calls).toHaveLength(1);
  });

  it('polls until ACTIVE after PENDING', async () => {
    const probe = fetchProbe((_call, n) => ({
      json: { state: n < 2 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE' },
    }));

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 5000,
      },
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(probe.calls).toHaveLength(3);
  });

  it('times out if never active', async () => {
    const probe = fetchProbe(PENDING_STEP);

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 50,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/poll timed out/);
  });

  it('uses callback function for auth token refresh', async () => {
    const probe = fetchProbe((_call, n) => ({
      json: { state: n < 1 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE' },
    }));

    const tokenFn = vi
      .fn()
      .mockResolvedValueOnce('token-1')
      .mockResolvedValueOnce('token-2');

    await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      tokenFn,
      {
        intervalMs: 10,
        timeoutMs: 5000,
      },
      probe.fetch,
    );

    expect(tokenFn).toHaveBeenCalledTimes(2);
    // The refreshed token is asserted where it actually matters — on the wire.
    const first = probe.calls[0].init.headers as Record<string, string>;
    const second = probe.calls[1].init.headers as Record<string, string>;
    expect(first.Authorization).toBe('Bearer token-1');
    expect(second.Authorization).toBe('Bearer token-2');
  });

  it('includes last state in timeout error message', async () => {
    const probe = fetchProbe(PENDING_STEP);

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 50,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/LEASE_STATE_PENDING/);
  });

  it('aborts immediately with a pre-aborted signal', async () => {
    const probe = fetchProbe(PENDING_STEP);

    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
          abortSignal: controller.signal,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(probe.calls).toHaveLength(0);
  });

  it('aborts during sleep between polls', async () => {
    const probe = fetchProbe(PENDING_STEP);

    const controller = new AbortController();
    // Abort after a short delay (during the sleep interval)
    setTimeout(() => controller.abort(new Error('user cancelled')), 30);

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 5000,
          timeoutMs: 30000,
          abortSignal: controller.signal,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/user cancelled/);
    // Should have polled once, then been aborted during sleep
    expect(probe.calls).toHaveLength(1);
  });

  it('invokes checkChainState before the provider on each iteration', async () => {
    const probe = fetchProbe((_call, n) => ({
      json: { state: n < 2 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE' },
    }));

    const checkChainState = vi.fn().mockResolvedValue(null);
    await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 5000,
        checkChainState,
      },
      probe.fetch,
    );

    expect(checkChainState).toHaveBeenCalledTimes(3);
  });

  it('throws TerminalChainStateError with typed chainState + leaseUuid fields', async () => {
    const probe = fetchProbe(PENDING_STEP);

    const checkChainState = vi.fn().mockResolvedValue({ state: 'rejected' });

    let caught: unknown;
    try {
      await pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
          checkChainState,
        },
        probe.fetch,
      );
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
    expect(probe.calls).toHaveLength(0);
  });

  it('maps closed and expired chain states onto their lease states', async () => {
    const probe = fetchProbe(PENDING_STEP);

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
          checkChainState: () => Promise.resolve({ state: 'closed' }),
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/LEASE_STATE_CLOSED on chain/);

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
          checkChainState: () => Promise.resolve({ state: 'expired' }),
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/LEASE_STATE_EXPIRED on chain/);
  });

  it('continues polling while checkChainState returns null', async () => {
    const probe = fetchProbe((_call, n) => ({
      json: { state: n < 1 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE' },
    }));

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
      probe.fetch,
    );
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(checkChainState).toHaveBeenCalledTimes(2);
  });

  it('abortSignal takes precedence over a terminal chainState in the same iteration', async () => {
    const probe = fetchProbe(PENDING_STEP);

    const controller = new AbortController();
    controller.abort(new Error('aborted before iteration'));
    const checkChainState = vi.fn().mockResolvedValue({ state: 'rejected' });

    // With a pre-aborted signal, the top-of-loop throwIfAborted fires before
    // checkChainState is ever called. Locks in the ordering.
    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
          abortSignal: controller.signal,
          checkChainState,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/aborted before iteration/);
    expect(checkChainState).not.toHaveBeenCalled();
  });

  it('honors abortSignal aborted while checkChainState is awaiting', async () => {
    const probe = fetchProbe(PENDING_STEP);

    const controller = new AbortController();
    const checkChainState = vi.fn(async () => {
      // Simulate a slow chain RPC; abort mid-await.
      await new Promise((r) => setTimeout(r, 20));
      controller.abort(new Error('cancelled during chain check'));
      await new Promise((r) => setTimeout(r, 5));
      return null;
    });

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
          abortSignal: controller.signal,
          checkChainState,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/cancelled during chain check/);

    // Provider status must not be fetched after the signal aborted.
    expect(probe.calls).toHaveLength(0);
    expect(checkChainState).toHaveBeenCalledTimes(1);
  });

  it('propagates errors thrown by checkChainState', async () => {
    const probe = fetchProbe(PENDING_STEP);

    const checkChainState = vi
      .fn()
      .mockRejectedValue(new Error('chain RPC down'));
    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 10,
          timeoutMs: 5000,
          checkChainState,
        },
        probe.fetch,
      ),
    ).rejects.toThrow(/chain RPC down/);
    expect(probe.calls).toHaveLength(0);
  });

  it('calls onProgress on each poll iteration', async () => {
    const probe = fetchProbe((_call, n) => ({
      json: { state: n < 2 ? 'LEASE_STATE_PENDING' : 'LEASE_STATE_ACTIVE' },
    }));

    const onProgress = vi.fn();
    await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 5000,
        onProgress,
      },
      probe.fetch,
    );

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
  /** Drive the poll from a script of per-iteration WIRE outcomes; the last repeats. */
  const scriptReads = (steps: ProbeStep[]): FetchProbe => fetchProbe(steps);

  /**
   * A tolerable provider blip, as it arrives ON THE WIRE. The `ProviderApiError` is built by
   * the real non-2xx block rather than by this file, so the status, the `kind: 'http'` tag
   * and the message-from-body composition are all under test instead of assumed. A body of
   * `'bad gateway'` is short enough that `capProviderText` is a no-op, so `.message` is that
   * string exactly — which is what the assertions below match on.
   */
  const transient = (status = 502): ProbeStep => ({
    status,
    text: 'bad gateway',
  });

  it('tolerates failures up to the budget and then succeeds', async () => {
    const probe = scriptReads([
      transient(),
      transient(),
      { json: { state: 'LEASE_STATE_ACTIVE' } },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 3 },
      probe.fetch,
    );

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(probe.calls).toHaveLength(3);
  });

  it('resets the counter on a successful read, so the budget is a BURST tolerance', async () => {
    // 5 failures total, never 4 in a row: with a cumulative counter this would
    // throw; with a consecutive one it resolves.
    const probe = scriptReads([
      transient(),
      transient(),
      PENDING_STEP,
      transient(),
      transient(),
      transient(),
      { json: { state: 'LEASE_STATE_ACTIVE' } },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 3 },
      probe.fetch,
    );

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(probe.calls).toHaveLength(7);
  });

  it('gives up past the budget with reason "provider_unreachable", naming the last error', async () => {
    const probe = scriptReads([transient(503)]);

    const err = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 2 },
      probe.fetch,
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
    expect(probe.calls).toHaveLength(3);
  });

  it('maxConsecutiveFailures: 0 restores the pre-ENG-661 fail-on-first-blip behaviour', async () => {
    const probe = scriptReads([transient()]);

    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 1,
          timeoutMs: 5000,
          maxConsecutiveFailures: 0,
        },
        probe.fetch,
      ),
    ).rejects.toBeInstanceOf(LeaseReadinessUnconfirmedError);
    expect(probe.calls).toHaveLength(1);
  });

  it('defaults to tolerating 3 consecutive failures', async () => {
    const probe = scriptReads([
      transient(),
      transient(),
      transient(),
      { json: { state: 'LEASE_STATE_ACTIVE' } },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000 },
      probe.fetch,
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
    // End to end now: the probe aborts the way an injected fetch with its own deadline
    // would, and the REAL classifyTransportError decides the tag. Nothing of ours aborted,
    // so its third arm produces the `kind: 'network'` this test used to hand-construct.
    const probe = scriptReads([
      {
        transportError: new DOMException(
          'The operation was aborted',
          'AbortError',
        ),
      },
      { json: { state: 'LEASE_STATE_ACTIVE' } },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 3 },
      probe.fetch,
    );

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(probe.calls).toHaveLength(2);
  });

  describe('never swallowed', () => {
    it.each([
      ['a 401 (auth is not a blip)', 401],
      ['a 403', 403],
      ['a 400', 400],
    ])('propagates %s on the FIRST iteration', async (_label, status) => {
      const probe = scriptReads([{ status, text: 'nope' }]);

      const err = await pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 5 },
        probe.fetch,
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProviderApiError);
      expect(err).not.toBeInstanceOf(LeaseReadinessUnconfirmedError);
      expect((err as ProviderApiError).status).toBe(status);
      expect(probe.calls).toHaveLength(1);
    });

    it('propagates an SSRF/URL rejection immediately (it will never change)', async () => {
      // The REAL validateProviderUrl runs now, so this uses a genuinely disallowed host —
      // the cloud metadata endpoint, blocked whatever `allowLoopback` is set to — instead of
      // hand-building the error the validator would have raised.
      const probe = fetchProbe(PENDING_STEP);

      await expect(
        pollLeaseUntilReady(
          'https://169.254.169.254',
          LEASE_UUID,
          AUTH_TOKEN,
          {
            intervalMs: 1,
            timeoutMs: 5000,
            maxConsecutiveFailures: 5,
          },
          probe.fetch,
        ),
      ).rejects.toThrow(/not allowed/);
      // Validation happens before dispatch, so the wire is never touched at all — a stronger
      // statement than "the mock was called once", and the reason it is never retried is now
      // carried by the rejection's TYPE rather than implied.
      expect(probe.calls).toHaveLength(0);
    });

    it('tolerates one off-contract response within the bounded poll budget', async () => {
      // Direct SDK reads still fail closed. This loop alone gives a rolling provider/WAF one more
      // look before abandoning a lease that has already been created on chain.
      const probe = scriptReads([
        { json: null },
        { json: { state: 'LEASE_STATE_ACTIVE' } },
      ]);

      const result = await pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 1,
          timeoutMs: 5000,
          maxConsecutiveFailures: 5,
        },
        probe.fetch,
      );

      expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
      expect(probe.calls).toHaveLength(2);
    });

    it('fails after an off-contract response exhausts the bounded poll budget', async () => {
      const probe = scriptReads([{ json: null }]);

      const err = await pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 1,
          timeoutMs: 5000,
          maxConsecutiveFailures: 1,
        },
        probe.fetch,
      ).catch((caught: unknown) => caught);

      expect(err).toBeInstanceOf(LeaseReadinessUnconfirmedError);
      expect(err).toMatchObject({
        consecutiveFailures: 2,
        cause: { status: 200, kind: 'invalid_response' },
      });
      expect(probe.calls).toHaveLength(2);
    });

    /**
     * The retryability half of ENG-703, pinned at the ONE production consumer of
     * `isTransientProviderError`. A cancel reaches this loop as the caller's own value —
     * over MCP that is `notification.params.reason`, a plain STRING — and leaving it
     * unwrapped is what makes it structurally incapable of being tolerated here.
     *
     * The value arrives from the WIRE: a body stream that errors mid-read. `classifyBodyError`
     * passes a non-timeout through UNCHANGED, so a non-Error reason keeps its identity all
     * the way out. Still NO `abortSignal`, deliberately — the VALUE alone must fail fast, so
     * the guarantee does not lean on the signal gate one line above it in the loop.
     */
    it('propagates a cancellation value, whatever shape it arrives in', async () => {
      const probe = scriptReads([{ streamError: 'user pressed stop' }]);

      const err = await pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 5 },
        probe.fetch,
      ).catch((e: unknown) => e);

      expect(err).toBe('user pressed stop');
      expect(probe.calls).toHaveLength(1);
    });

    it('a PROVISION_FAILED verdict still fails fast, however large the budget', async () => {
      const probe = fetchProbe({
        json: {
          state: 'LEASE_STATE_ACTIVE',
          provision_status: 'failed',
        },
      });

      await expect(
        pollLeaseUntilReady(
          PROVIDER_URL,
          LEASE_UUID,
          AUTH_TOKEN,
          {
            intervalMs: 1,
            timeoutMs: 5000,
            maxConsecutiveFailures: 99,
          },
          probe.fetch,
        ),
      ).rejects.toThrow(/provisioning failed/);
      expect(probe.calls).toHaveLength(1);
    });

    it('a terminal lease state still fails fast, however large the budget', async () => {
      const probe = fetchProbe({
        json: {
          state: 'LEASE_STATE_CLOSED',
        },
      });

      await expect(
        pollLeaseUntilReady(
          PROVIDER_URL,
          LEASE_UUID,
          AUTH_TOKEN,
          {
            intervalMs: 1,
            timeoutMs: 5000,
            maxConsecutiveFailures: 99,
          },
          probe.fetch,
        ),
      ).rejects.toThrow(/terminal state/);
      expect(probe.calls).toHaveLength(1);
    });

    it('an abort racing a transient failure surfaces the abort, not the tolerance', async () => {
      // The abort reason is deliberately a TOLERABLE value — a 503, which
      // `isTransientProviderError` accepts. A cancel is surfaced as the caller's own reason
      // verbatim, and a caller may abort with anything, so that makes the loop's
      // `abortSignal?.throwIfAborted()` the ONLY thing standing between a cancel and the
      // failure budget: remove it and the read is COUNTED and logged as a provider blip.
      // The rejection is identical either way, so the warn log — not the rejection — is the
      // discriminator, and asserting on it is what keeps this test honest.
      const warnLines: string[] = [];
      const warnSpy = vi
        .spyOn(logger, 'warn')
        .mockImplementation((m: unknown) => {
          warnLines.push(String(m));
        });
      try {
        const controller = new AbortController();
        const reason = new ProviderApiError(503, 'unavailable', {
          kind: 'http',
        });
        const probe = fetchProbe(() => {
          controller.abort(reason);
          return { hang: true };
        });

        const startedAt = Date.now();
        // A 5s interval means a "tolerate first, notice the abort later" bug blows vitest's
        // 5s test timeout — the failure mode we want.
        const err = await pollLeaseUntilReady(
          PROVIDER_URL,
          LEASE_UUID,
          AUTH_TOKEN,
          {
            intervalMs: 5_000,
            timeoutMs: 60_000,
            maxConsecutiveFailures: 5,
            abortSignal: controller.signal,
          },
          probe.fetch,
        ).catch((e: unknown) => e);

        expect(err).toBe(reason);
        expect(probe.calls).toHaveLength(1);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(
          warnLines.filter((l) => l.includes('status read failed')),
        ).toEqual([]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('an abort DURING the post-failure backoff cancels the wait', async () => {
      const controller = new AbortController();
      const probe = fetchProbe(transient());
      setTimeout(
        () => controller.abort(new Error('cancelled mid-backoff')),
        20,
      );

      const startedAt = Date.now();
      await expect(
        pollLeaseUntilReady(
          PROVIDER_URL,
          LEASE_UUID,
          AUTH_TOKEN,
          {
            intervalMs: 5_000,
            timeoutMs: 60_000,
            maxConsecutiveFailures: 5,
            abortSignal: controller.signal,
          },
          probe.fetch,
        ),
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
    const probe = scriptReads([
      { status: 404, text: 'lease not found' },
      { status: 404, text: 'lease not found' },
      { json: { state: 'LEASE_STATE_ACTIVE' } },
    ]);

    const result = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 3 },
      probe.fetch,
    );

    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(probe.calls).toHaveLength(3);
  });

  it('still gives up on a 404 that never resolves — the tolerance is bounded', async () => {
    const probe = scriptReads([{ status: 404, text: 'lease not found' }]);

    const err = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 1, timeoutMs: 5000, maxConsecutiveFailures: 2 },
      probe.fetch,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LeaseReadinessUnconfirmedError);
    expect((err as LeaseReadinessUnconfirmedError).reason).toBe(
      'provider_unreachable',
    );
    expect(probe.calls).toHaveLength(3);
  });

  it('honours a provider Retry-After instead of the poll interval', async () => {
    // `Retry-After` is delta-SECONDS on the wire, so 1s is the smallest hint a provider can
    // actually express — the old 60ms was only reachable because the mock skipped the header
    // parse entirely. The real `parseRetryAfterMs` runs now.
    const probe = scriptReads([
      { status: 429, text: 'rate limited', headers: { 'retry-after': '1' } },
      { json: { state: 'LEASE_STATE_ACTIVE' } },
    ]);

    const startedAt = Date.now();
    await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 1,
        timeoutMs: 5_000,
      },
      probe.fetch,
    );

    // Waited the header's second rather than the 1ms interval.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('never sleeps a Retry-After past the deadline', async () => {
    const probe = scriptReads([
      {
        status: 503,
        text: 'unavailable',
        // Fred caps its own header at 86400s; honouring that literally would park the poll
        // for a day. The clamp against the remaining deadline is what this pins.
        headers: { 'retry-after': '86400' },
      },
    ]);

    const startedAt = Date.now();
    await expect(
      pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          intervalMs: 1,
          timeoutMs: 40,
          maxConsecutiveFailures: 99,
        },
        probe.fetch,
      ),
    ).rejects.toBeInstanceOf(LeaseReadinessUnconfirmedError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('pollLeaseUntilReady — deadline (ENG-661)', () => {
  it("defaults to the provider's own 10-minute provisioning allowance", () => {
    // Fred's docker backend: ProvisionTimeout 10m, of which ImagePullTimeout is
    // 5m. The old 120s default gave up ~5x early on a healthy cold start.
    expect(DEFAULT_POLL_TIMEOUT_MS).toBe(10 * 60 * 1_000);
  });

  it('applies DEFAULT_POLL_TIMEOUT_MS when no timeoutMs is given', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const probe = fetchProbe(PENDING_STEP);

      const settled = pollLeaseUntilReady(
        PROVIDER_URL,
        LEASE_UUID,
        AUTH_TOKEN,
        {
          // Explicit, large interval: only the DEADLINE is under test, and the
          // 3s default would mean ~200 mock reads.
          intervalMs: 60_000,
        },
        probe.fetch,
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
    const probe = fetchProbe({
      json: {
        state: 'LEASE_STATE_ACTIVE',
        provision_status: 'provisioning',
      },
    });

    const err = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 50,
      },
      probe.fetch,
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
    const probe = fetchProbe(PENDING_STEP);

    const err = await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 30,
      },
      probe.fetch,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderApiError);
    expect(ProviderApiError.isProviderApiError(err)).toBe(true);
    expect((err as ProviderApiError).status).toBe(0);
    expect((err as ProviderApiError).kind).toBe('poll');
    expect((err as Error).name).toBe('LeaseReadinessUnconfirmedError');
  });

  it('withContext preserves the stack and adds provider identity', async () => {
    const probe = fetchProbe(PENDING_STEP);

    const err = (await pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      {
        intervalMs: 10,
        timeoutMs: 30,
      },
      probe.fetch,
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
  const FROM = '11111111-2222-3333-4444-555555555555';

  it('POSTs {from_lease_uuid} JSON to /restore with Bearer auth and returns status', async () => {
    const probe = fetchProbe({ json: { status: 'provisioning' } });

    const res = await restoreLease(
      PROVIDER_URL,
      LEASE_UUID,
      FROM,
      AUTH_TOKEN,
      probe.fetch,
    );

    expect(res.status).toBe('provisioning');
    expect(probe.calls).toHaveLength(1);
    const { url, init } = probe.calls[0];
    expect(url).toBe(`${PROVIDER_URL}/v1/leases/${LEASE_UUID}/restore`);
    expect(init.method).toBe('POST');
    // `toEqual`, not `objectContaining`: the mutate POSTs are the coverage ENG-705 most
    // wants kept, and an extra header on a mutate should have to be acknowledged.
    expect(init.headers).toEqual({
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    });
    // ENG-696 C9: the signal is observed rather than merely tolerated. NOTE for the
    // cancellation work — this is the INTERNAL deadline, not a caller signal: `restoreLease`
    // has no signal parameter at all, which is C3's "guarded only by parameter-list absence".
    // This assertion is what makes that decision visible the day it changes.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init)).toEqual(['method', 'headers', 'body', 'signal']);
    expect(JSON.parse(init.body as string)).toEqual({ from_lease_uuid: FROM });
  });

  it('propagates a non-2xx ProviderApiError with its status (e.g. 422 demote)', async () => {
    // The 422 comes off the WIRE and the real non-2xx block builds the error, so the status,
    // the `kind` tag and the message-from-body composition are under test rather than
    // asserted into existence by the fixture.
    const probe = fetchProbe({
      status: 422,
      text: 'retained data exceeds the requested smaller tier',
    });
    await expect(
      restoreLease(PROVIDER_URL, LEASE_UUID, FROM, AUTH_TOKEN, probe.fetch),
    ).rejects.toMatchObject({
      status: 422,
      kind: 'http',
      message: 'retained data exceeds the requested smaller tier',
    });
  });
});

describe('updateLease', () => {
  it('sends JSON body with base64-encoded payload', async () => {
    const probe = fetchProbe({ json: { status: 'updated' } });

    const payload = new TextEncoder().encode('{"image":"nginx:alpine"}');
    await updateLease(
      PROVIDER_URL,
      LEASE_UUID,
      payload,
      AUTH_TOKEN,
      probe.fetch,
    );

    expect(probe.calls).toHaveLength(1);
    const { url, init } = probe.calls[0];
    expect(url).toBe(`${PROVIDER_URL}/v1/leases/${LEASE_UUID}/update`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init)).toEqual(['method', 'headers', 'body', 'signal']);

    const body = JSON.parse(init.body as string) as { payload: string };
    expect(atob(body.payload)).toBe('{"image":"nginx:alpine"}');
  });

  it('handles large payloads without stack overflow', async () => {
    const probe = fetchProbe({ json: { status: 'updated' } });

    // 128KB payload — ensures large payloads are handled correctly
    const large = new Uint8Array(128 * 1024).fill(65); // all 'A'
    await updateLease(PROVIDER_URL, LEASE_UUID, large, AUTH_TOKEN, probe.fetch);

    const body = JSON.parse(probe.calls[0].init.body as string) as {
      payload: string;
    };
    const decoded = atob(body.payload);
    expect(decoded.length).toBe(128 * 1024);
    expect(decoded[0]).toBe('A');
  });
});

/**
 * What actually reaches the transport (ENG-696 C9).
 *
 * The old assertions matched the `init` bag with `expect.objectContaining({ method, headers })`,
 * so a `signal` landing inside it passed WITHOUT being observed — the file carried a comment
 * conceding exactly that. None of the facts below were assertable through the module mock,
 * and a cancellation ticket needs them pinned before it threads a signal anywhere.
 *
 * Identity with the caller's signal is deliberately NOT asserted, and could never hold:
 * `checkedFetchWithin` dispatches `{ ...init, signal: deadline.signal }`, where
 * `deadline.signal` is `armDeadline`'s COMPOSED caller-signal + internal-timeout controller.
 * The observable consequences of that composition are what get asserted instead — `.aborted`,
 * and `.reason` by reference.
 */
describe('the wire seam — what reaches fetch (ENG-696 C9)', () => {
  it('always dispatches a composed AbortSignal, even from a fn with no signal parameter', async () => {
    // `getLeaseLogs` takes no signal at all, yet the transport still arms one.
    const probe = fetchProbe({ json: leaseLogs() });
    await getLeaseLogs(PROVIDER_URL, LEASE_UUID, AUTH_TOKEN, 50, probe.fetch);

    const { init } = probe.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(Object.keys(init)).toEqual(['headers', 'signal']);
  });

  it("a caller's signal reaches the wire, and its own reason arrives with it", async () => {
    const controller = new AbortController();
    const reason = new Error('host cancelled');
    const probe = fetchProbe({ hang: true });

    const settled = getLeaseStatus(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      probe.fetch,
      controller.signal,
    ).catch((e: unknown) => e);

    // Let the dispatch happen before aborting.
    await new Promise((r) => setTimeout(r, 10));
    expect(probe.calls).toHaveLength(1);
    const observed = probe.calls[0].init.signal as AbortSignal;
    // A composition, never the caller's own instance.
    expect(observed).not.toBe(controller.signal);
    expect(observed.aborted).toBe(false);

    controller.abort(reason);

    // The composition forwards the caller's reason BY REFERENCE...
    expect(observed.aborted).toBe(true);
    expect(observed.reason).toBe(reason);
    // ...and the transport rethrows it UNWRAPPED, which is what leaves
    // `isTransientProviderError` structurally unable to tolerate a user's cancel.
    await expect(settled).resolves.toBe(reason);
  });

  it('a pre-aborted caller signal never reaches the wire at all', async () => {
    // `checkedFetchWithin` calls `throwIfAborted()` BEFORE dispatch. ENG-696 C4 turns on this
    // being provable: a request that provably never left must stay distinguishable from one
    // that may have been received.
    const controller = new AbortController();
    controller.abort('stopped'); // a bare STRING — the MCP `params.reason` shape
    const probe = fetchProbe({ json: { state: 'LEASE_STATE_ACTIVE' } });

    const err = await getLeaseStatus(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      probe.fetch,
      controller.signal,
    ).catch((e: unknown) => e);

    expect(probe.calls).toHaveLength(0);
    expect(err).toBe('stopped');
  });

  it('the poll threads its abortSignal all the way to the wire', async () => {
    // `pollLeaseUntilReady` calls `getLeaseStatus` SAME-MODULE, so this edge is reachable by
    // dependency injection only — no `vi.mock('./fred.js')` could ever observe it.
    const controller = new AbortController();
    const reason = new Error('host cancelled');
    const probe = fetchProbe({ hang: true });

    const settled = pollLeaseUntilReady(
      PROVIDER_URL,
      LEASE_UUID,
      AUTH_TOKEN,
      { intervalMs: 10, timeoutMs: 30_000, abortSignal: controller.signal },
      probe.fetch,
    ).catch((e: unknown) => e);

    await new Promise((r) => setTimeout(r, 10));
    expect(probe.calls).toHaveLength(1);
    const observed = probe.calls[0].init.signal as AbortSignal;
    expect(observed).not.toBe(controller.signal);

    controller.abort(reason);
    expect(observed.aborted).toBe(true);
    expect(observed.reason).toBe(reason);
    await expect(settled).resolves.toBe(reason);
  });
});
