import type {
  CosmosClientManager,
  EventSocket,
  EventTransport,
  LeaseUuid,
} from '@manifest-network/manifest-mcp-core';
import { LeaseState, noopLogger } from '@manifest-network/manifest-mcp-core';
import { leaseStatusWire } from '@manifest-network/manifest-mcp-core/__test-utils__/fred-wire.js';
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

/** Verbatim from Fred's non-in-flight deprovision callback (provisioner/handler_set.go:222-225).
 *  Note it arrives in the frame's `error` slot but is a RESTORE INSTRUCTION, not a failure cause. */
const RETAINED_HINT =
  'your lease data was retained and can be restored within the grace window: create a fresh PENDING lease of matching shape, then POST /v1/leases/{new_lease_uuid}/restore with from_lease_uuid set to this lease’s UUID';

const wsFrame = (status: string, error?: string) =>
  JSON.stringify({
    lease_uuid: LEASE_UUID,
    status,
    ...(error ? { error } : {}),
    timestamp: '2026-07-14T00:00:00Z',
  });

describe('waitForLeaseStatus — WebSocket transport (ctx.events)', () => {
  it('appends /events + ?token and resolves on a ready event confirmed against /status (no poll fallback)', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      // ENG-651: a terminal-candidate frame is CONFIRMED against /status, so the fixture must supply
      // the document the provider would serve. Frame 0 is the snapshot-on-open, frame 1 the confirm.
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' },
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

  it('a failed event resolves from the AUTHORITATIVE /status document, not the frame', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
        leaseStatusWire({
          era: 'post-eng508',
          outcome: 'failed',
          leaseUuid: LEASE_UUID,
        }) as unknown as RawFrame,
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
    // The provider's own document wins: post-ENG-508 it carries the curated reason/message pair,
    // which the three-field frame cannot. This is the transport-parity property — a WS-resolved
    // terminal is the same document a poll-resolved one would be.
    expect(final.reason).toBe('ContainerExited');
    expect(final.message).toBe('container exited unexpectedly');
    expect(final.fail_count).toBe(3);
  });

  it('falls back to the frame for a FAILED event when the confirm read fails (asymmetric policy)', async () => {
    // A terminal-negative frame is self-sufficient: it carries its own failure detail and a re-read
    // could only confirm it. So an unreachable provider must not strand a failure the client was
    // already told about — and the ENG-638 `error` → `message`/`last_error` mapping is preserved.
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [],
      fetch: vi
        .fn()
        .mockRejectedValue(
          new Error('provider unreachable'),
        ) as unknown as typeof globalThis.fetch,
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    // No openCb: the confirm read is the only fetch, and it rejects.
    sockets[0].msgCb?.(wsFrame('failed', 'image pull error'));

    const final = await p;
    expect(isLeaseFailureTerminal(final)).toBe(true);
    // ENG-638: the frame's `error` is Fred's callback.Error — the same value it
    // assigns to ProvisionState.Message — so it maps to the canonical `message`.
    expect(final.message).toBe('image pull error');
    // Deprecated mirror, kept one release for SDK consumers reading the old key.
    expect(final.last_error).toBe('image pull error');
    // Never fabricated: the frame carries no reason.
    expect(final.reason).toBeUndefined();
  });

  it('does NOT resolve a success-shaped event when the confirm read fails (the other half of the asymmetry)', async () => {
    // The mirror of the test above, and the heart of ENG-651: a `ready` frame is NOT self-sufficient.
    // It cannot distinguish a live lease from one that has been closed and soft-deleted, so an
    // unverifiable success must never settle the wait. Timing out is the honest outcome.
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [],
      fetch: vi
        .fn()
        .mockRejectedValue(
          new Error('provider unreachable'),
        ) as unknown as typeof globalThis.fetch,
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { timeout: 60 });
    // Assert the INVARIANT (it must not resolve), not which of two legitimate
    // rejections wins the race to the 60ms deadline. Both exits are correct
    // behaviour: `waitViaWs` throws `timedOutError` when the deadline elapses
    // mid-connection, and otherwise `waitForLeaseStatus` deliberately falls back
    // to `waitViaPoll`, whose immediate transport rejection escapes. Which one
    // lands depends on whether the WS driver exits before the deadline, i.e. on
    // scheduling — pinning /timed out/ made this flaky (~1-2 runs in 15) and
    // meant that on most runs the confirm-read path it exists to exercise was
    // never even reached. See ENG-780.
    // Attach the handlers WITHOUT awaiting — awaiting here would settle the wait
    // on its deadline before the frame is ever pushed, and the confirm-read path
    // this test exists for would never run.
    const settledPromise = p.then(
      (status) => ({ resolved: true as const, status }),
      (err: unknown) => ({ resolved: false as const, err }),
    );
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].msgCb?.(wsFrame('ready'));
    const settled = await settledPromise;

    expect(
      settled.resolved,
      'a `ready` frame whose confirm read failed is unverifiable and must never settle the wait',
    ).toBe(false);
    // Not vacuous: it must be one of the two legitimate rejections, so a
    // regression that rejects for some unrelated reason still fails here.
    // (`in` narrows the union; `toBe(false)` above does not narrow for TS.)
    const message = !('err' in settled)
      ? ''
      : settled.err instanceof Error
        ? settled.err.message
        : String(settled.err);
    expect(message).toMatch(/timed out|provider unreachable/);
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
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' }, // the confirm read
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
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' }, // the confirm read
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
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' }, // the confirm read
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
      // Two non-terminal snapshots (one per socket's onOpen) so neither connection resolves from its
      // snapshot; the third fetch is the confirm read for the `ready` frame on the SECOND socket.
      statusFrames: [
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
        { state: 'LEASE_STATE_PENDING', provision_status: 'provisioning' },
        { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' },
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
    // The confirm read is a promise chain; flush it under fake timers before awaiting.
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toEqual(
      expect.objectContaining({ provision_status: 'ready' }),
    );
  });
});

// ── ENG-651: a RETAINED lease must never resolve as a successful deploy ─────────────────────────
//
// Fred publishes `provision_status: "retained"` when a backend tears a lease down but KEEPS its
// volumes (provisioner/handler_set.go:215-225). The value is in neither PROVISION_IN_PROGRESS nor
// PROVISION_FAILED, so the ACTIVE branch's fall-through called it `success`.
//
// The verdict depends on the CHAIN state, which is why the WS frame — carrying a provision status
// and no state (backend/events.go:5-12) — cannot decide on its own:
//
//   ACTIVE + retained    the backend tore it down out-of-band and the chain state is unchanged;
//                        the reconciler re-provisions on its next sweep (reconciler.go:991,
//                        README state matrix "ACTIVE | Not provisioned | Anomaly: provision")
//                        ⇒ NOT terminal. Keep waiting.
//   CLOSED + retained    orphan; deprovision. Strictly terminal, restorable onto a FRESH lease.
//
// A frame therefore decides only WHEN to classify, never WHAT the state is.
const RETAINED_WIRE_CLOSED = leaseStatusWire({
  era: 'post-eng508',
  outcome: 'retained',
  leaseUuid: LEASE_UUID,
}) as unknown as RawFrame;

// The same retained record while the chain lease is still ACTIVE — reachable because Fred emits the
// retained notice from its NON-in-flight deprovision branch ("Chain state is unchanged") and ENG-329
// surfaces provision_status for any lease state.
const RETAINED_WIRE_ACTIVE = {
  ...RETAINED_WIRE_CLOSED,
  state: 'LEASE_STATE_ACTIVE',
} as RawFrame;

/** A fetch whose responses are released by the test, so a frame can be delivered while a `/status`
 *  read is genuinely in flight. Returns the deferred queue plus the fetch to inject. */
function makeDeferredFetch(bodies: RawFrame[]) {
  const releases: Array<() => void> = [];
  let i = 0;
  const fetch = vi.fn(async () => {
    const body = JSON.stringify(bodies[Math.min(i, bodies.length - 1)]);
    i += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    return {
      ok: true,
      status: 200,
      text: async () => body,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    /** Release the Nth outstanding read (0-based) and let its microtasks drain. */
    release: async (n = 0) => {
      releases[n]?.();
      await new Promise((r) => setTimeout(r, 0));
    },
    pending: () => releases.length,
  };
}

describe('waitForLeaseStatus — stale-read supersession (ENG-651, PR #172 review)', () => {
  it('a newer frame arriving mid-read prevents the stale document from resolving success', async () => {
    // The read for the `ready` frame is issued, then the lease FAILS and Fred pushes a `failed`
    // frame while that GET is still in flight. The in-flight read can only answer for the state at
    // issue time, so honouring it would resolve a successful deploy for a lease we have already been
    // told failed — the ticket's defect wearing a different hat. The newest frame must win, and the
    // superseded read must be discarded and re-issued rather than dropped.
    const deferred = makeDeferredFetch([
      { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' }, // stale: pre-failure
      leaseStatusWire({
        era: 'post-eng508',
        outcome: 'failed',
        leaseUuid: LEASE_UUID,
      }) as unknown as RawFrame, // the re-read, post-failure
    ]);
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [],
      fetch: deferred.fetch,
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { timeout: 5_000 });
    await vi.waitFor(() => expect(sockets.length).toBe(1));

    sockets[0].msgCb?.(wsFrame('ready')); // → issues read #1 (the stale one)
    await vi.waitFor(() => expect(deferred.pending()).toBe(1));
    sockets[0].msgCb?.(wsFrame('failed', 'OOMKilled')); // lands while read #1 is in flight
    await deferred.release(0); // read #1 answers with the pre-failure document

    // Read #1 was superseded, so it must not have settled anything; the loop re-reads.
    await vi.waitFor(() => expect(deferred.pending()).toBe(2));
    await deferred.release(1);

    const final = await p;
    expect(isLeaseFailureTerminal(final)).toBe(true);
    expect(final.provision_status).toBe('failed');
  });

  it('a candidate frame supersedes an in-flight snapshot-on-open', async () => {
    // Same rule for the earliest read in the connection, which is the likeliest to be stale.
    const deferred = makeDeferredFetch([
      { state: 'LEASE_STATE_ACTIVE', provision_status: 'ready' }, // stale snapshot-on-open
      leaseStatusWire({
        era: 'post-eng508',
        outcome: 'retained',
        leaseUuid: LEASE_UUID,
      }) as unknown as RawFrame, // the confirm-read: CLOSED + retained
    ]);
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [],
      fetch: deferred.fetch,
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { timeout: 5_000 });
    await vi.waitFor(() => expect(sockets.length).toBe(1));

    sockets[0].openCb?.(); // → issues the snapshot read
    await vi.waitFor(() => expect(deferred.pending()).toBe(1));
    sockets[0].msgCb?.(wsFrame('retained', RETAINED_HINT)); // lands while the snapshot is in flight
    await deferred.release(0); // the snapshot answers "ready" — but it is now stale

    await vi.waitFor(() => expect(deferred.pending()).toBe(2));
    await deferred.release(1);

    const final = await p;
    expect(isLeaseFailureTerminal(final)).toBe(true);
    expect(final.provision_status).toBe('retained');
    expect(final.state).toBe(LeaseState.LEASE_STATE_CLOSED);
  });
});

describe('waitForLeaseStatus — retained (ENG-651)', () => {
  it('WS: a retained frame on a CLOSED lease resolves as a failure terminal, carrying the retention metadata', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [RETAINED_WIRE_CLOSED],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { timeout: 5_000 });
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    // Deliberately NO openCb(): skip snapshot-on-open so the frame path alone is under test.
    sockets[0].msgCb?.(wsFrame('retained', RETAINED_HINT));

    const final = await p;
    expect(isLeaseFailureTerminal(final)).toBe(true);
    expect(final.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(final.provision_status).toBe('retained');
    // Enough for the caller to reach restore_app and judge whether the window is still open.
    expect(final.retained_until).toBe('2026-09-01T00:00:00Z');
  });

  it('WS: a retained frame on a still-ACTIVE lease does NOT settle — the reconciler re-provisions', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [RETAINED_WIRE_ACTIVE],
    });
    const { transport, sockets } = makeFakeEvents();
    (ctx as { events?: EventTransport }).events = transport;

    const p = waitForLeaseStatus(ctx, LEASE_UUID, { timeout: 60 });
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(sockets.length).toBe(1));
    sockets[0].msgCb?.(wsFrame('retained', RETAINED_HINT));
    await assertion;
  });

  it('poll: ACTIVE + retained keeps polling instead of reporting a ready deploy', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [RETAINED_WIRE_ACTIVE],
    });
    await expect(
      waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 5, timeout: 60 }),
    ).rejects.toThrow(/timed out/);
  });

  // GREEN ORACLE — passes before AND after the fix. The poll path already classifies a CLOSED
  // retained lease correctly via the chain-state branch; this pins that the WS work did not move it.
  it('poll: CLOSED + retained is a failure terminal (unchanged by the WS fix)', async () => {
    const ctx = makeWaitCtx({
      providerUuid: 'p1',
      statusFrames: [RETAINED_WIRE_CLOSED],
    });
    const final = await waitForLeaseStatus(ctx, LEASE_UUID, { intervalMs: 5 });
    expect(isLeaseFailureTerminal(final)).toBe(true);
    expect(final.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(final.provision_status).toBe('retained');
    expect(final.retained_until).toBe('2026-09-01T00:00:00Z');
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
