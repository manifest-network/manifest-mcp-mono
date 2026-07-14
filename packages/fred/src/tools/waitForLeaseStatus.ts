import {
  type CapabilityCtx,
  type EventTransport,
  type FredLeaseStatus,
  LeaseState,
  type LeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  abortableSleep,
  getLeaseStatus,
  PROVISION_FAILED,
  PROVISION_IN_PROGRESS,
} from '../http/fred.js';
import { validateProviderUrl } from '../http/provider.js';
import type { ProviderAuthPort } from '../http/provider-auth.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

/** The capability slice waitForLeaseStatus needs: query (provider lookup) + chain (rate limit +
 *  chainId + broadcast address) + fetch (provider HTTP) + providerAuth (mints the per-poll ADR-036
 *  status token). `logger` is an ACTIVE dependency (contains a throwing onStatus). `events`, WHEN
 *  present, transparently upgrades the wait from polling to a provider WebSocket (poll is the fallback). */
export type WaitForLeaseStatusCtx = Pick<
  CapabilityCtx,
  'query' | 'chain' | 'fetch' | 'logger' | 'events'
> & { providerAuth: ProviderAuthPort; readonly allowLoopback?: boolean };

export interface WaitForLeaseStatusOptions {
  /** Optional INTERMEDIATE progress. Deduped on (state, provision_status) unless emitEvery.
   *  NOT fired for the terminal status — that arrives via the resolved promise (render `final` too). */
  onStatus?: (status: FredLeaseStatus) => void;
  /** Caller cancellation. Aborting REJECTS with signal.reason and cancels the in-flight wait. */
  signal?: AbortSignal;
  /** Overall DEADLINE in ms (default 120000). Reaching it on a non-terminal lease REJECTS. */
  timeout?: number;
  /** Poll interval in ms (default 3000). Also the snapshot cadence; the WS path uses it for the fallback. */
  intervalMs?: number;
  /** false (default) = dedup onStatus on (state, provision_status); true = raw per-event. */
  emitEvery?: boolean;
}

/** Terminal classification, mirroring `pollLeaseUntilReady` in http/fred.ts but returning a verdict
 *  instead of resolve/throw. Reuses the EXPORTED PROVISION_* sets so it never drifts. */
type Terminal = 'success' | 'failure' | 'pending';
function classifyTerminal(s: FredLeaseStatus): Terminal {
  switch (s.state) {
    case LeaseState.LEASE_STATE_ACTIVE: {
      const ps = s.provision_status;
      if (ps !== undefined) {
        if (PROVISION_FAILED.has(ps)) return 'failure';
        if (PROVISION_IN_PROGRESS.has(ps)) return 'pending';
      }
      return 'success'; // ACTIVE + settled/absent/unrecognized provision_status (forward-compat, like pollLeaseUntilReady)
    }
    case LeaseState.LEASE_STATE_CLOSED:
    case LeaseState.LEASE_STATE_REJECTED:
    case LeaseState.LEASE_STATE_EXPIRED:
      return 'failure';
    default:
      return 'pending'; // PENDING / UNRECOGNIZED — keep watching until terminal or the deadline
  }
}

/** True iff `status` is a lease-FAILURE terminal. PRECONDITION: call only on a settled/terminal
 *  status (the resolved promise value) — returns false for a PENDING status, so do NOT infer success
 *  by negation on a non-terminal snapshot. */
export function isLeaseFailureTerminal(status: FredLeaseStatus): boolean {
  return classifyTerminal(status) === 'failure';
}

// ── WebSocket transport tunables (matched to Fred + the barney connectLeaseEvents this replaces) ──
// Reset only on DATA frames (onOpen/onMessage), like barney — the WS ping/pong that keeps the TCP
// connection alive is handled inside the transport and is NOT surfaced as activity. So a healthy but
// silent socket (a slow provisioning step emitting no transitions for >45s) is treated as dead and
// reconnects; that is a bounded, self-healing reconnect (re-snapshots current state), not a failure.
// Fred pings every 30s, so 45s gives headroom over a normal transition cadence.
const WS_LIVENESS_TIMEOUT_MS = 45_000;
// A dropped socket is retried a couple of times (short fixed delay) before falling back to polling.
const WS_RECONNECT_DELAY_MS = 1_000;
const WS_MAX_RECONNECT_ATTEMPTS = 2;
// Close codes that mean "do not reconnect": a policy/protocol violation (Fred sends 1008 if a client
// sends data on this push-only stream) or reserved app-level auth-reject codes (4001/4003). Matches
// barney's PERMANENT_WS_CLOSE_CODES. (Fred auth failures occur pre-upgrade as HTTP errors — never a WS close.)
const PERMANENT_WS_CLOSE_CODES: ReadonlySet<number> = new Set([
  1008, 4001, 4003,
]);

/** The Fred `/events` WS frame (`LeaseStatusEvent`): a provision-status transition. UNTRUSTED. */
interface FredWsEvent {
  readonly status: string;
  readonly error?: string;
}

/** Parse an untrusted WS text frame into a `FredWsEvent`, or `null` if it isn't a status event. */
function parseFredWsEvent(data: string): FredWsEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.status !== 'string') return null;
  return {
    status: o.status,
    ...(typeof o.error === 'string' && o.error !== ''
      ? { error: o.error }
      : {}),
  };
}

/**
 * Map a Fred WS event to a `FredLeaseStatus`. The `/events` stream only fires while the chain lease is
 * ACTIVE and carries the provider `provision_status` (not the chain state), so we pin `state: ACTIVE`
 * and let `classifyTerminal` decide ready/failed/pending from `provision_status` — the same logic the
 * poll path applies. (Fred's wire field is `error`; barney historically mis-read `last_error`.)
 */
function mapWsEventToStatus(event: FredWsEvent): FredLeaseStatus {
  return {
    state: LeaseState.LEASE_STATE_ACTIVE,
    provision_status: event.status,
    phase: event.status,
    ...(event.error !== undefined ? { last_error: event.error } : {}),
  };
}

/** Build the Fred lease-events WS URL from a validated provider base URL: ws(s) + /events + ?token. */
function buildWsUrl(
  validatedBase: string,
  leaseUuid: LeaseUuid,
  token: string,
): string {
  const u = new URL(validatedBase);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/$/, '')}/v1/leases/${encodeURIComponent(leaseUuid)}/events`;
  u.searchParams.set('token', token);
  return u.toString();
}

interface DriverArgs {
  readonly ctx: WaitForLeaseStatusCtx;
  readonly leaseUuid: LeaseUuid;
  readonly providerUrl: string;
  readonly address: string;
  readonly signal: AbortSignal | undefined;
  readonly intervalMs: number;
  readonly deadlineAt: number;
  readonly emit: (status: FredLeaseStatus) => void;
}

/** Poll `/v1/leases/{uuid}/status` until terminal (the fallback and the no-`ctx.events` default). */
async function waitViaPoll(a: DriverArgs): Promise<FredLeaseStatus> {
  const {
    ctx,
    leaseUuid,
    providerUrl,
    address,
    signal,
    intervalMs,
    deadlineAt,
  } = a;
  for (;;) {
    signal?.throwIfAborted(); // abort observed between polls
    let status: FredLeaseStatus;
    try {
      const token = await ctx.providerAuth.providerToken({
        address,
        leaseUuid,
      });
      status = await getLeaseStatus(
        providerUrl,
        leaseUuid,
        token,
        ctx.fetch,
        signal,
        ctx.allowLoopback,
      );
    } catch (err) {
      if (signal?.aborted) throw signal.reason; // abort-during-fetch: reject with the abort reason FIRST
      throw err; // network/parse → reject
    }
    if (classifyTerminal(status) !== 'pending') return status; // resolve (terminal NOT emitted via onStatus)
    a.emit(status);
    if (Date.now() >= deadlineAt) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `waitForLeaseStatus timed out after reaching the deadline; lease ${leaseUuid} still non-terminal`,
      );
    }
    await abortableSleep(intervalMs, signal); // rejects with signal.reason on abort during the interval
  }
}

type ConnOutcome =
  | { readonly kind: 'terminal'; readonly status: FredLeaseStatus }
  | { readonly kind: 'reconnect' }
  | { readonly kind: 'permanent'; readonly error: Error }
  | { readonly kind: 'aborted'; readonly reason: unknown };

/** Drive ONE WS connection: snapshot-on-open, stream events, liveness, abort. Resolves an outcome. */
function runWsConnection(
  events: EventTransport,
  wsUrl: string,
  validatedBase: string,
  token: string,
  a: DriverArgs,
): Promise<ConnOutcome> {
  const { ctx, leaseUuid, signal, emit } = a;
  return new Promise<ConnOutcome>((resolve) => {
    const sock = events.open(wsUrl);
    let settled = false;
    let livenessTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = signal
      ? () => finish({ kind: 'aborted', reason: signal.reason })
      : undefined;

    const finish = (outcome: ConnOutcome): void => {
      if (settled) return;
      settled = true;
      if (livenessTimer) clearTimeout(livenessTimer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      sock.close();
      resolve(outcome);
    };

    const resetLiveness = (): void => {
      if (settled) return; // never re-arm after the attempt has resolved (a late frame must not leak a timer)
      if (livenessTimer) clearTimeout(livenessTimer);
      // No frame (incl. Fred's 30s pings mediated by the transport) within the window ⇒ treat as dead.
      livenessTimer = setTimeout(
        () => finish({ kind: 'reconnect' }),
        WS_LIVENESS_TIMEOUT_MS,
      );
    };

    const consider = (status: FredLeaseStatus): void => {
      if (settled) return; // never emit / resolve twice from a frame that lands after finish()
      if (classifyTerminal(status) !== 'pending') {
        finish({ kind: 'terminal', status });
        return;
      }
      emit(status);
    };

    if (signal)
      signal.addEventListener('abort', onAbort as () => void, { once: true });
    if (signal?.aborted) {
      finish({ kind: 'aborted', reason: signal.reason });
      return;
    }

    sock.onOpen(() => {
      resetLiveness();
      // The WS stream only carries FUTURE transitions; snapshot the current state once so an
      // already-terminal / already-ready lease resolves immediately (best-effort — keep streaming on error).
      void (async () => {
        try {
          const snap = await getLeaseStatus(
            validatedBase,
            leaseUuid,
            token,
            ctx.fetch,
            signal,
            ctx.allowLoopback,
          );
          if (!settled) consider(snap);
        } catch {
          /* snapshot best-effort */
        }
      })();
    });

    sock.onMessage((data) => {
      if (settled) return; // ignore frames delivered during/after the close handshake
      resetLiveness();
      const ev = parseFredWsEvent(data);
      if (ev) consider(mapWsEventToStatus(ev));
    });

    sock.onClose((code) => {
      finish(
        PERMANENT_WS_CLOSE_CODES.has(code)
          ? {
              kind: 'permanent',
              error: new ManifestMCPError(
                ManifestMCPErrorCode.QUERY_FAILED,
                `Fred lease-events WebSocket closed with permanent code ${code}`,
              ),
            }
          : { kind: 'reconnect' },
      );
    });

    // An error without a subsequent close still resolves the attempt as reconnectable.
    sock.onError(() => finish({ kind: 'reconnect' }));
  });
}

/** WS-backed wait: reconnect a bounded number of times, then let the caller fall back to polling. */
async function waitViaWs(a: DriverArgs): Promise<FredLeaseStatus> {
  const { ctx, leaseUuid, providerUrl, address, signal, deadlineAt } = a;
  const events = ctx.events;
  if (!events) throw new Error('waitViaWs requires ctx.events'); // caller-guaranteed; narrow the type
  const validatedBase = validateProviderUrl(providerUrl, {
    allowLoopback: ctx.allowLoopback,
  });

  for (let attempt = 0; attempt < WS_MAX_RECONNECT_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason;
    if (Date.now() >= deadlineAt) break;

    const token = await ctx.providerAuth.providerToken({ address, leaseUuid });
    const wsUrl = buildWsUrl(validatedBase, leaseUuid, token);
    const outcome = await runWsConnection(
      events,
      wsUrl,
      validatedBase,
      token,
      a,
    );

    if (outcome.kind === 'terminal') return outcome.status;
    if (outcome.kind === 'aborted') throw outcome.reason;
    if (outcome.kind === 'permanent') throw outcome.error;
    // reconnect: short delay before the next attempt (if any budget remains).
    if (attempt < WS_MAX_RECONNECT_ATTEMPTS - 1 && Date.now() < deadlineAt) {
      await abortableSleep(WS_RECONNECT_DELAY_MS, signal);
    }
  }
  // Exhausted WS attempts — signal the caller to fall back to polling.
  throw new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    `Fred lease-events WebSocket unavailable for lease ${leaseUuid}`,
  );
}

/**
 * Wait for a lease's Fred provision status to converge to a terminal state. RESOLVES with the final
 * FredLeaseStatus at ANY terminal (success OR observed failure — use isLeaseFailureTerminal). REJECTS
 * on setup failure, deadline (timeout), and abort (signal → reject with signal.reason).
 *
 * Transport: when `ctx.events` is present, transparently uses the provider `/events` WebSocket
 * (snapshot-on-connect + streamed transitions, bounded reconnect, liveness), falling back to polling
 * `/status` on any WS failure. Without `ctx.events` it polls. `onStatus` reports INTERMEDIATE updates
 * only, deduped unless `emitEvery`; the transport choice does not change the observable contract.
 */
export async function waitForLeaseStatus(
  ctx: WaitForLeaseStatusCtx,
  leaseUuid: LeaseUuid,
  opts: WaitForLeaseStatusOptions = {},
): Promise<FredLeaseStatus> {
  const { signal, onStatus, emitEvery } = opts;
  const intervalMs = opts.intervalMs ?? 3_000;
  const timeoutMs = opts.timeout ?? 120_000;

  signal?.throwIfAborted(); // prompt pre-abort: no chain/provider work

  await ctx.chain.acquireRateLimit();
  const address = await ctx.chain.getAddress();
  const leaseRes = await ctx.query.liftedinit.billing.v1.lease({ leaseUuid });
  if (!leaseRes.lease) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Lease "${leaseUuid}" not found on chain`,
    );
  }
  const providerUrl = await resolveProviderUrl(
    ctx,
    leaseRes.lease.providerUuid,
  );

  let lastKey: string | undefined;
  const emit = (status: FredLeaseStatus): void => {
    if (!onStatus) return;
    const key = `${status.state}|${status.provision_status ?? ''}`;
    if (emitEvery || key !== lastKey) {
      lastKey = key;
      try {
        onStatus(status);
      } catch (cbErr) {
        ctx.logger.warn(
          `waitForLeaseStatus: onStatus callback threw and was contained: ${
            cbErr instanceof Error ? cbErr.message : String(cbErr)
          }`,
        );
      }
    }
  };

  const args: DriverArgs = {
    ctx,
    leaseUuid,
    providerUrl,
    address,
    signal,
    intervalMs,
    deadlineAt: Date.now() + timeoutMs,
    emit,
  };

  if (ctx.events) {
    try {
      return await waitViaWs(args);
    } catch (err) {
      // A deliberate abort is never downgraded to a poll — surface it.
      if (signal?.aborted) throw signal.reason;
      ctx.logger.warn(
        `waitForLeaseStatus: WebSocket transport failed, falling back to polling: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return waitViaPoll(args);
    }
  }
  return waitViaPoll(args);
}
