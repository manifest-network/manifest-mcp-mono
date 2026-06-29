import type {
  CosmosClientManager,
  LeaseUuid,
} from '@manifest-network/manifest-mcp-core';
import { LeaseState, noopLogger } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAuthPort } from '../http/provider-auth.js';
import type { SubscribeCtx } from './subscribeLeaseStatus.js';
import { subscribeLeaseStatus } from './subscribeLeaseStatus.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000' as LeaseUuid;
const PROVIDER_URL = 'https://provider.example.com';

interface RawFrame {
  state: string;
  provision_status?: string;
  [k: string]: unknown;
}

/**
 * Build a SubscribeCtx whose `ctx.fetch` returns the given raw status frames (cycling once exhausted)
 * as Response-shaped objects, driving the REAL getLeaseStatus parse path (validateProviderUrl +
 * leaseStateFromJSON) — NOT a vi.mock of getLeaseStatus. The per-poll status token is minted off the
 * injected `providerAuth` port (the single fred auth convention); the address is resolved per setup via
 * `ctx.chain.getAddress()`. Pass `getAddressRejects` to exercise the signer-less/address-failure path
 * (which now surfaces via the `getAddress` resolve, not a `requireAuthSigner` throw).
 */
function makeSubscribeCtx(opts: {
  providerUuid: string;
  statusFrames: RawFrame[];
  getAddressRejects?: boolean;
  fetch?: typeof globalThis.fetch;
}): SubscribeCtx {
  const query = makeMockQueryClient({
    billing: {
      lease: {
        uuid: LEASE_UUID,
        state: LeaseState.LEASE_STATE_PENDING,
        providerUuid: opts.providerUuid,
      },
    },
    sku: {
      providerLookup: {
        [opts.providerUuid]: { provider: { apiUrl: PROVIDER_URL } },
      },
    },
  });

  let i = 0;
  const fetch =
    opts.fetch ??
    (vi.fn(async () => {
      const frame =
        opts.statusFrames[Math.min(i, opts.statusFrames.length - 1)];
      i += 1;
      const body = JSON.stringify(frame);
      return {
        ok: true,
        status: 200,
        text: async () => body,
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch);

  const chain = {
    acquireRateLimit: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn().mockReturnValue({ chainId: 'test-chain' }),
    getAddress: opts.getAddressRejects
      ? vi.fn().mockRejectedValue(new Error('no signer configured'))
      : vi.fn().mockResolvedValue('manifest1abc'),
  } as unknown as CosmosClientManager;

  const providerAuth: ProviderAuthPort = {
    providerToken: vi.fn().mockResolvedValue('mock-provider-token'),
    leaseDataToken: vi.fn().mockResolvedValue('mock-lease-data-token'),
  };

  return {
    query,
    chain,
    fetch,
    providerAuth,
    logger: noopLogger,
  } as SubscribeCtx;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribeLeaseStatus', () => {
  it('dedups onData on (state, provision_status) and stops on unsubscribe', async () => {
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const onData = vi.fn();
    const onComplete = vi.fn();
    const stop = subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData,
      onComplete,
      intervalMs: 10,
    });
    // Advance well past several intervalMs (10ms) ticks so MULTIPLE polls fire — the per-poll
    // token now comes from the injected providerAuth fake (no wall-clock-second gating), so polls
    // are paced purely by intervalMs. 3x ~1.1s advances drive many identical polls — the fetch
    // count below documents they collapse to a single onData via dedup.
    for (let k = 0; k < 3; k++) {
      await vi.advanceTimersByTimeAsync(1_100);
    }
    const fetchMock = ctx.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // several identical polls...
    expect(onData).toHaveBeenCalledTimes(1); // ...collapsed to one emit by the (state, provision_status) dedup
    expect(onData).toHaveBeenCalledWith(
      expect.objectContaining({ state: LeaseState.LEASE_STATE_PENDING }),
    );
    expect(onComplete).not.toHaveBeenCalled();
    stop();
    stop(); // idempotent
  });

  it('emitEvery: true emits raw per-poll', async () => {
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const onData = vi.fn();
    const stop = subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData,
      intervalMs: 1_000,
      emitEvery: true,
    });
    // Advance across several intervalMs (1000ms) ticks so multiple polls fire — paced purely by
    // intervalMs now that the per-poll token comes from the providerAuth fake (no second-gating).
    for (let k = 0; k < 3; k++) {
      await vi.advanceTimersByTimeAsync(1_100);
    }
    expect(onData.mock.calls.length).toBeGreaterThan(1); // raw per-poll, no dedup
    stop();
  });

  it('terminal-success → final onData + onComplete + auto-stop', async () => {
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'running' },
      ],
    });
    const onData = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData,
      onComplete,
      onError,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ state: LeaseState.LEASE_STATE_ACTIVE }),
    );
    expect(onError).not.toHaveBeenCalled();
    const calls = onData.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(onData.mock.calls.length).toBe(calls); // auto-stopped
  });

  it('terminal-FAILURE is delivered via onComplete, NOT onError', async () => {
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'failed' },
      ],
    });
    const onComplete = vi.fn();
    const onError = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: vi.fn(),
      onComplete,
      onError,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ provision_status: 'failed' }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('terminal chain failure state (CLOSED) → onComplete, NOT onError', async () => {
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [{ state: 'LEASE_STATE_CLOSED' }],
    });
    const onComplete = vi.fn();
    const onError = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: vi.fn(),
      onComplete,
      onError,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ state: LeaseState.LEASE_STATE_CLOSED }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('timeout (stuck non-terminal lease) → onError', async () => {
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const onError = vi.fn();
    const onComplete = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: vi.fn(),
      onError,
      onComplete,
      intervalMs: 1_000,
      timeout: 1_500,
    });
    // Each poll mints a fresh token via providerAuth.providerToken. After a couple of
    // intervalMs advances the still-PENDING lease passes the deadline → loud onError
    // (a stuck lease is not a quiet done).
    for (let k = 0; k < 3; k++) {
      await vi.advanceTimersByTimeAsync(1_100);
    }
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('abort via opts.signal stops silently (no onError, no onComplete)', async () => {
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const onError = vi.fn();
    const onComplete = vi.fn();
    const controller = new AbortController();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: vi.fn(),
      onError,
      onComplete,
      intervalMs: 10,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(5); // first poll emitted, mid-interval
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('setup failure (lease not found) → onError', async () => {
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'running' },
      ],
    });
    // Force the chain lease lookup to report no lease.
    ctx.query.liftedinit.billing.v1.lease = vi
      .fn()
      .mockResolvedValue({ lease: null }) as never;
    const onError = vi.fn();
    const onComplete = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: vi.fn(),
      onError,
      onComplete,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('address-resolve failure (signer-less ctx) surfaces via onError (no sync throw)', async () => {
    vi.useFakeTimers();
    // With providerAuth as the single auth convention, signer is no longer on the ctx; the
    // setup path resolves the broadcast address via ctx.chain.getAddress(). A rejecting
    // getAddress (the signer-less manager) must surface via onError, never a sync throw.
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'running' },
      ],
      getAddressRejects: true,
    });
    const onError = vi.fn();
    const onComplete = vi.fn();
    // Must NOT throw synchronously.
    const stop = subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: vi.fn(),
      onError,
      onComplete,
      intervalMs: 10,
    });
    expect(typeof stop).toBe('function');
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    stop();
  });

  it('poll network/parse error → onError + stop', async () => {
    vi.useFakeTimers();
    // A rejecting fetch (network error) — getLeaseStatus surfaces it as a throw.
    const fetch = vi
      .fn()
      .mockRejectedValue(
        new Error('socket hang up'),
      ) as unknown as typeof globalThis.fetch;
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [{ state: 'LEASE_STATE_PENDING' }],
      fetch,
    });
    const onError = vi.fn();
    const onComplete = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: vi.fn(),
      onError,
      onComplete,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(5);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    // stopped — no more polls
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('contains a throwing onData callback: the watch still converges (onComplete fires) and the fault is not re-routed to onError', async () => {
    // Code-review PR #102: a consumer callback that throws synchronously must
    // not escape the void-ed poll loop (unhandled rejection) nor abort the
    // converging watch. With a terminal-success frame, a throwing onData is
    // contained so the terminal onComplete still fires. (Without containment,
    // the throw skips onComplete and rejects the IIFE.)
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'running' },
      ],
    });
    const onComplete = vi.fn();
    const onError = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: () => {
        throw new Error('consumer onData blew up');
      },
      onComplete,
      onError,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(onComplete).toHaveBeenCalledTimes(1); // converged despite the throw
    expect(onError).not.toHaveBeenCalled(); // a callback fault is NOT a watch error
  });

  it('self-termination does not abort a caller-provided signal (cleanup flows source→composite only)', async () => {
    // Code-review PR #102: on self-termination the watch aborts its INTERNAL
    // controller (which detaches the AbortSignal.any listener from opts.signal).
    // That cleanup must never propagate back to the CALLER's signal.
    vi.useFakeTimers();
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'running' },
      ],
    });
    const controller = new AbortController();
    const onComplete = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData: vi.fn(),
      onComplete,
      intervalMs: 10,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(false);
  });

  it('§5.9 contract: a Fred status wire frame parses to the emitted FredLeaseStatus shape', async () => {
    vi.useFakeTimers();
    const frame = {
      state: 'LEASE_STATE_ACTIVE',
      provision_status: 'running',
      phase: 'Running',
      instances: [
        {
          name: 'web-0',
          status: 'running',
          ports: { '80': 30080 },
          fqdn: 'app.example.com',
        },
      ],
      endpoints: { web: 'https://app.example.com' },
    };
    const ctx = makeSubscribeCtx({
      providerUuid: 'prov-1',
      statusFrames: [frame],
    });
    const onData = vi.fn();
    subscribeLeaseStatus(ctx, LEASE_UUID, {
      onData,
      onComplete: vi.fn(),
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(1);
    const emitted = onData.mock.calls[0][0];
    expect(emitted.state).toBe(LeaseState.LEASE_STATE_ACTIVE); // string → enum (real leaseStateFromJSON)
    expect(emitted.provision_status).toBe('running');
    expect(emitted.instances[0].fqdn).toBe('app.example.com');
  });
});
