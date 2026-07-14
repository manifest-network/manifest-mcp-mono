import type {
  CosmosClientManager,
  EventSocket,
  EventTransport,
  LeaseUuid,
} from '@manifest-network/manifest-mcp-core';
import { LeaseState, noopLogger } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAuthPort } from '../http/provider-auth.js';
import type { WaitForLeaseStatusCtx } from './waitForLeaseStatus.js';
import {
  isLeaseFailureTerminal,
  waitForLeaseStatus,
} from './waitForLeaseStatus.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000' as LeaseUuid;
const PROVIDER_URL = 'https://provider.example.com';

interface RawFrame {
  state: string;
  provision_status?: string;
  [k: string]: unknown;
}

function makeWaitCtx(opts: {
  providerUuid: string;
  statusFrames: RawFrame[];
  getAddressRejects?: boolean;
  fetch?: typeof globalThis.fetch;
}): WaitForLeaseStatusCtx {
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
  } as WaitForLeaseStatusCtx;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('waitForLeaseStatus', () => {
  it('resolves with the final status on a success terminal', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_ACTIVE' }],
    });
    const final = await waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 1 });
    expect(final.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(isLeaseFailureTerminal(final)).toBe(false);
  });

  it('resolves (does NOT reject) on a CLOSED failure terminal — caller inspects', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_CLOSED' }],
    });
    const final = await waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 1 });
    expect(final.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(isLeaseFailureTerminal(final)).toBe(true);
  });

  it('resolves on ACTIVE + PROVISION_FAILED and isLeaseFailureTerminal is true', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'failed' },
      ],
    });
    const final = await waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 1 });
    expect(isLeaseFailureTerminal(final)).toBe(true);
  });

  it('onStatus fires for INTERMEDIATE polls only, deduped — NOT for the terminal', async () => {
    vi.useFakeTimers();
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
        { state: 'LEASE_STATE_ACTIVE' },
      ],
    });
    const onStatus = vi.fn();
    const p = waitForLeaseStatus(ctx, LEASE_UUID, { onStatus, intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(50);
    const final = await p;
    expect(final.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    // the two identical PENDING polls dedup to ONE onStatus; the terminal ACTIVE is NOT emitted.
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: LeaseState.LEASE_STATE_PENDING }),
    );
  });

  it('emitEvery: true emits onStatus raw per intermediate poll', async () => {
    vi.useFakeTimers();
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING' },
        { state: 'LEASE_STATE_PENDING' },
        { state: 'LEASE_STATE_ACTIVE' },
      ],
    });
    const onStatus = vi.fn();
    const p = waitForLeaseStatus(ctx, LEASE_UUID, {
      onStatus,
      emitEvery: true,
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(onStatus).toHaveBeenCalledTimes(2); // both PENDING polls, terminal excluded
  });

  it('a throwing onStatus is contained — the promise still resolves', async () => {
    vi.useFakeTimers();
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING' },
        { state: 'LEASE_STATE_ACTIVE' },
      ],
    });
    const p = waitForLeaseStatus(ctx, LEASE_UUID, {
      onStatus: () => {
        throw new Error('consumer bug');
      },
      intervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(30);
    await expect(p).resolves.toEqual(
      expect.objectContaining({ state: LeaseState.LEASE_STATE_ACTIVE }),
    );
  });

  it('rejects on setup failure (lease not found on chain)', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_ACTIVE' }],
    });
    // Override the chain lease query to return no lease.
    (ctx.query.liftedinit.billing.v1.lease as unknown as ReturnType<
      typeof vi.fn
    >) = vi.fn().mockResolvedValue({ lease: undefined });
    await expect(
      waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 1 }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects on a network/parse error from the poll', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [],
      fetch: vi
        .fn()
        .mockRejectedValue(
          new Error('boom'),
        ) as unknown as typeof globalThis.fetch,
    });
    await expect(
      waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 1 }),
    ).rejects.toThrow(/boom/);
  });

  it('rejects on the poll deadline for a stuck non-terminal lease', async () => {
    vi.useFakeTimers();
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_PENDING' }],
    });
    const p = waitForLeaseStatus(ctx, LEASE_UUID, {
      intervalMs: 10,
      timeout: 25,
    });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('a PRE-ABORTED signal rejects with signal.reason and does NO poll', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_ACTIVE' }],
    });
    const reason = new DOMException('cancelled', 'AbortError');
    const p = waitForLeaseStatus(ctx, LEASE_UUID, {
      signal: AbortSignal.abort(reason),
      intervalMs: 1,
    });
    await expect(p).rejects.toBe(reason);
    expect(ctx.chain.getAddress).not.toHaveBeenCalled(); // setup did not run
  });

  it('aborting while a poll is pending rejects with signal.reason (never resolves undefined)', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_PENDING' }],
    });
    const reason = new DOMException('stop', 'AbortError');
    const p = waitForLeaseStatus(ctx, LEASE_UUID, {
      signal: controller.signal,
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(5); // let the first poll complete, land in the interval sleep
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
  });

  it('aborting while a poll FETCH is in flight rejects with signal.reason (exercises the catch abort-first branch)', async () => {
    const controller = new AbortController();
    const reason = new DOMException('stop', 'AbortError');
    // A fetch that stays pending until the signal aborts, then rejects with a DIFFERENT raw error than
    // signal.reason — mimics an in-flight provider request being cancelled. The tool's catch must
    // normalize to signal.reason (abort-first), so if that branch were deleted the caller would see
    // 'raw fetch failure' and this assertion would fail.
    const fetch = vi.fn(
      () =>
        new Promise((_res, rej) => {
          controller.signal.addEventListener(
            'abort',
            () => rej(new Error('raw fetch failure')),
            { once: true },
          );
        }),
    ) as unknown as typeof globalThis.fetch;
    const ctx = makeWaitCtx({ providerUuid: 'p1', statusFrames: [], fetch });
    const p = waitForLeaseStatus(ctx, LEASE_UUID, {
      signal: controller.signal,
      intervalMs: 1,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); // the poll fetch is now in flight
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
  });

  it('waits with no opts', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_ACTIVE' }],
    });
    await expect(waitForLeaseStatus(ctx, LEASE_UUID)).resolves.toBeDefined();
  });
});

// ── WS transport (ctx.events) ────────────────────────────────────────────────────────────────────
class FakeSocket implements EventSocket {
  msgCb?: (d: string) => void;
  openCb?: () => void;
  closeCb?: (c: number, r: string) => void;
  errCb?: (e: Error) => void;
  closed = false;
  constructor(readonly url: string) {}
  onMessage(cb: (d: string) => void) {
    this.msgCb = cb;
  }
  onOpen(cb: () => void) {
    this.openCb = cb;
  }
  onClose(cb: (c: number, r: string) => void) {
    this.closeCb = cb;
  }
  onError(cb: (e: Error) => void) {
    this.errCb = cb;
  }
  close() {
    this.closed = true;
  }
}

function makeFakeEvents() {
  const sockets: FakeSocket[] = [];
  const transport: EventTransport = {
    open: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  };
  return { transport, sockets };
}

const wsFrame = (status: string, error?: string) =>
  JSON.stringify({
    lease_uuid: LEASE_UUID,
    status,
    ...(error ? { error } : {}),
    timestamp: '2026-07-14T00:00:00Z',
  });

describe('waitForLeaseStatus — WebSocket transport (ctx.events)', () => {
  it('appends /events + ?token and resolves on a ready event (no polling)', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    expect(sockets[0].url).toBe(
      `wss://provider.example.com/v1/leases/${LEASE_UUID}/events?token=mock-provider-token`,
    );
    sockets[0].openCb?.(); // snapshot poll → PENDING → keep streaming
    await Promise.resolve();
    sockets[0].msgCb?.(wsFrame('ready'));

    const final = await p;
    expect(final.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(final.provision_status).toBe('ready');
    expect(isLeaseFailureTerminal(final)).toBe(false);
    expect(sockets[0].closed).toBe(true); // socket closed on resolve
  });

  it('maps a failed event (error field) to a failure terminal', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].openCb?.();
    await Promise.resolve();
    sockets[0].msgCb?.(wsFrame('failed', 'image pull error'));

    const final = await p;
    expect(isLeaseFailureTerminal(final)).toBe(true);
    expect(final.last_error).toBe('image pull error'); // Fred wire field is `error` → last_error
  });

  it('snapshot-on-open resolves an already-terminal lease before any event', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_ACTIVE' }], // snapshot = ready
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].openCb?.(); // snapshot alone resolves

    const final = await p;
    expect(final.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
  });

  it('reconnects after a non-permanent close, then resolves', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].closeCb?.(1006, 'drop'); // non-permanent → reconnect (after ~1s)
    await vi.waitFor(() => expect(sockets.length).toBe(2), { timeout: 3000 });
    sockets[1].openCb?.();
    await Promise.resolve();
    sockets[1].msgCb?.(wsFrame('ready'));

    const final = await p;
    expect(final.provision_status).toBe('ready');
  }, 8000);

  it('a permanent close (1008) falls back to polling', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_ACTIVE' }], // poll resolves
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 1 });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].closeCb?.(1008, 'auth'); // permanent → no reconnect → poll fallback

    const final = await p;
    expect(final.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(sockets.length).toBe(1); // did NOT reconnect on a permanent close
  });

  it('falls back to polling after exhausting reconnect attempts', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_ACTIVE' }],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 1 });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].errCb?.(new Error('drop 1')); // reconnect
    await vi.waitFor(() => expect(sockets.length).toBe(2), { timeout: 3000 });
    sockets[1].closeCb?.(1006, 'drop 2'); // exhausted → poll fallback

    const final = await p;
    expect(final.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
  }, 8000);

  it('a pre-aborted signal rejects before opening any socket', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [{ state: 'LEASE_STATE_ACTIVE' }],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;
    const reason = new DOMException('cancelled', 'AbortError');

    await expect(
      waitForLeaseStatus(ctx, LEASE_UUID, {
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(sockets.length).toBe(0);
  });

  it('onStatus fires for intermediate WS events, never for the terminal', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;
    const onStatus = vi.fn();

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { onStatus });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].openCb?.();
    sockets[0].msgCb?.(wsFrame('provisioning')); // intermediate → emitted
    sockets[0].msgCb?.(wsFrame('ready')); // terminal → resolves, NOT emitted

    const final = await p;
    expect(final.provision_status).toBe('ready');
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ provision_status: 'provisioning' }),
    );
    expect(onStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ provision_status: 'ready' }),
    );
  });

  it('ignores a frame delivered after the wait already resolved (no late onStatus / timer leak)', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;
    const onStatus = vi.fn();

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { onStatus });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].openCb?.();
    sockets[0].msgCb?.(wsFrame('ready')); // terminal → resolve
    await p;
    onStatus.mockClear();

    // A frame buffered during the close handshake arrives AFTER settle — must be a no-op.
    sockets[0].msgCb?.(wsFrame('provisioning'));
    await Promise.resolve();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('aborting mid-stream rejects with signal.reason and closes the socket', async () => {
    const controller = new AbortController();
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;
    const reason = new DOMException('stop', 'AbortError');

    const p = waitForLeaseStatus(ctx, LEASE_UUID, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].openCb?.(); // streaming; nothing terminal yet
    controller.abort(reason);

    await expect(p).rejects.toBe(reason);
    expect(sockets[0].closed).toBe(true); // the abort path closes the socket
  });

  it('enforces the overall timeout on a chatty-but-never-terminal stream (rejects, no run past deadline)', async () => {
    vi.useFakeTimers();
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { timeout: 5_000 });
    // Attach the rejection assertion up front so the eventual reject isn't an unhandled rejection.
    const assertion = expect(p).rejects.toThrow(/timed out after 5000ms/);
    for (let i = 0; i < 25 && sockets.length < 1; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sockets.length).toBe(1);
    sockets[0].openCb?.();

    // Stay "chatty" with non-terminal frames (each resets the 45s liveness) but never terminalize,
    // across the 5s overall deadline. The deadline backstop must still fire and reject.
    await vi.advanceTimersByTimeAsync(2_000);
    sockets[0].msgCb?.(wsFrame('provisioning'));
    await vi.advanceTimersByTimeAsync(2_000);
    sockets[0].msgCb?.(wsFrame('provisioning'));
    await vi.advanceTimersByTimeAsync(2_000); // crosses 5s

    await assertion;
    expect(sockets[0].closed).toBe(true); // deadline tore the socket down (no leak)
    expect(sockets.length).toBe(1); // did NOT reconnect on a deadline
  });

  it('a silent socket hits the 45s liveness timeout and reconnects', async () => {
    vi.useFakeTimers();
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
      ],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    // vi.waitFor polls via (faked) timers and would deadlock — flush the pure-microtask setup manually.
    const flush = async () => {
      for (let i = 0; i < 25 && sockets.length < 1; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
    };

    const p = waitForLeaseStatus(ctx, LEASE_UUID);
    await flush();
    expect(sockets.length).toBe(1);
    sockets[0].openCb?.(); // arms the 45s liveness timer; then goes silent

    // 45s liveness fires → finish(reconnect); the ~1s reconnect delay → a second socket opens.
    await vi.advanceTimersByTimeAsync(45_000 + 1_000);
    for (let i = 0; i < 25 && sockets.length < 2; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(sockets.length).toBe(2);
    expect(sockets[0].closed).toBe(true); // the silent socket was torn down

    sockets[1].openCb?.();
    sockets[1].msgCb?.(wsFrame('ready'));
    await expect(p).resolves.toEqual(
      expect.objectContaining({ provision_status: 'ready' }),
    );
  });
});

describe('isLeaseFailureTerminal', () => {
  const mk = (state: LeaseState, provision_status?: string) =>
    ({
      state,
      provision_status,
    }) as unknown as import('@manifest-network/manifest-mcp-core').FredLeaseStatus;
  it('true for CLOSED/REJECTED/EXPIRED and ACTIVE+PROVISION_FAILED', () => {
    expect(isLeaseFailureTerminal(mk(LeaseState.LEASE_STATE_CLOSED))).toBe(
      true,
    );
    expect(isLeaseFailureTerminal(mk(LeaseState.LEASE_STATE_REJECTED))).toBe(
      true,
    );
    expect(isLeaseFailureTerminal(mk(LeaseState.LEASE_STATE_EXPIRED))).toBe(
      true,
    );
    expect(
      isLeaseFailureTerminal(mk(LeaseState.LEASE_STATE_ACTIVE, 'failed')),
    ).toBe(true);
  });
  it('false for a success terminal and for pending', () => {
    expect(isLeaseFailureTerminal(mk(LeaseState.LEASE_STATE_ACTIVE))).toBe(
      false,
    );
    expect(isLeaseFailureTerminal(mk(LeaseState.LEASE_STATE_PENDING))).toBe(
      false,
    );
  });
});
