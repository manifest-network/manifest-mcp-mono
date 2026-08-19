import {
  abortableSleep,
  type CapabilityCtx,
  type EventTransport,
  type FredLeaseStatus,
  LeaseState,
  type LeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { getLeaseStatus } from '../http/fred.js';
import { validateProviderUrl } from '../http/provider.js';
import type { ProviderAuthPort } from '../http/provider-auth.js';
import {
  PROVISION_FAILED,
  PROVISION_IN_PROGRESS,
  PROVISION_SUCCESS,
  warnIfUnrecognizedProvisionStatus,
} from '../readiness/poll-lease-readiness.js';
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
 *  instead of resolve/throw. Reuses the EXPORTED PROVISION_* sets so it never drifts.
 *
 *  PRECONDITION: `s` must be a status the PROVIDER authored — a `/status` document. Never hand this
 *  a status synthesized from a `/events` frame with a guessed `state`: the frame carries no chain
 *  state, and the same provision_status means opposite things at different states (ENG-651). */
type Terminal = 'success' | 'failure' | 'pending';
function classifyTerminal(s: FredLeaseStatus, leaseUuid?: string): Terminal {
  switch (s.state) {
    case LeaseState.LEASE_STATE_ACTIVE: {
      const ps = s.provision_status;
      if (ps !== undefined) {
        if (PROVISION_FAILED.has(ps)) return 'failure';
        if (!PROVISION_SUCCESS.has(ps)) {
          // In-progress, retained, or unrecognized. Not CONFIRMED healthy in any of those cases, so
          // keep watching — success is an allowlist, never a fall-through (ENG-651; see
          // PROVISION_SUCCESS). `retained` lands here when the chain lease is still ACTIVE, which is
          // correct: Fred's reconciler re-provisions an ACTIVE lease it finds unprovisioned, so the
          // lease is coming back rather than gone.
          warnIfUnrecognizedProvisionStatus(ps, leaseUuid);
          return 'pending';
        }
      }
      return 'success'; // ACTIVE + `ready`, or an absent field (a provider that never populates it)
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
 * Map a Fred WS event to a `FredLeaseStatus` for the two cases where the frame is self-sufficient:
 * a KNOWN in-progress status (pure progress reporting) and a PROVISION_FAILED frame whose
 * authoritative re-read failed. In both, the lease demonstrably still exists as a live chain lease,
 * so pinning `state: ACTIVE` states something true. (Fred's wire field is `error`; barney
 * historically mis-read `last_error`.)
 *
 * ENG-651: it is NOT true in general, and this function used to be called for every frame. The
 * `/events` frame carries a provision status and no chain state, so ACTIVE was a guess — and for
 * `retained` (published when a backend tore the deployment down but kept its volumes) the guess put
 * a closed, soft-deleted lease into `classifyTerminal`'s ACTIVE branch, where the settled-status
 * fall-through called it a successful deploy. Terminal-candidate frames now trigger a `/status` read
 * and the provider's own document is classified instead; see `confirmViaStatus`.
 *
 * ENG-638: ENG-508 did NOT change this frame — `LeaseStatusEvent` still carries `error`. But that
 * value is Fred's `callback.Error`, which is the SAME string Fred assigns to `ProvisionState.Message`
 * (`p.Message = info.CallbackErr`), so it is semantically the curated `message`, not the verbose
 * `last_error` ENG-508 redacted. Populate `message` — which makes a WS-derived status shape-identical
 * to a post-ENG-508 poll snapshot, and `waitForLeaseStatus` resolves the same type from both
 * transports. `last_error` is kept as a deprecated mirror for one release because the resolved status
 * is published on the SDK `/deploy` subpath and an existing consumer may still read that key.
 *
 * No `reason` is synthesized: the frame carries none, and defaulting it to `Unknown` would fabricate
 * machine-readable data. If Fred ever adds `reason` to the frame, whitelist it in `parseFredWsEvent`
 * and pass it through here — that is the whole change.
 */
function mapWsEventToStatus(event: FredWsEvent): FredLeaseStatus {
  return {
    state: LeaseState.LEASE_STATE_ACTIVE,
    provision_status: event.status,
    phase: event.status,
    ...(event.error !== undefined
      ? { message: event.error, last_error: event.error }
      : {}),
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
  readonly timeoutMs: number;
  readonly deadlineAt: number;
  readonly emit: (status: FredLeaseStatus) => void;
  /** Mutable scratch shared by both drivers: the last provision_status actually observed, so the
   *  deadline rejection can name it. Held in an object because DriverArgs itself is readonly. */
  readonly observed: { lastProvisionStatus?: string };
}

/** The overall-deadline rejection, shared by the poll and WS paths so the message stays consistent.
 *  Names the last provision_status observed: since an unrecognized status now keeps the wait running
 *  rather than reporting success (ENG-651), a timeout is the honest "could not determine" outcome and
 *  has to say what it last saw — otherwise the diagnosis is invisible. Mirrors the detail
 *  `pollLeaseUntilReady`'s own timeout already carries. */
function timedOutError(
  leaseUuid: LeaseUuid,
  timeoutMs: number,
  lastProvisionStatus?: string,
): ManifestMCPError {
  return new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    `waitForLeaseStatus timed out after ${timeoutMs}ms; lease ${leaseUuid} still non-terminal ` +
      `(last provision_status: ${lastProvisionStatus ?? 'unknown'})`,
  );
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
    a.observed.lastProvisionStatus = status.provision_status;
    if (classifyTerminal(status, leaseUuid) !== 'pending') return status; // resolve (terminal NOT emitted via onStatus)
    a.emit(status);
    if (Date.now() >= deadlineAt)
      throw timedOutError(
        leaseUuid,
        a.timeoutMs,
        a.observed.lastProvisionStatus,
      );
    await abortableSleep(intervalMs, signal); // rejects with signal.reason on abort during the interval
  }
}

type ConnOutcome =
  | { readonly kind: 'terminal'; readonly status: FredLeaseStatus }
  | { readonly kind: 'reconnect' }
  | { readonly kind: 'permanent'; readonly error: Error }
  // The overall `timeout` deadline elapsed while THIS connection was in-flight (hung open, or a
  // chatty-but-never-terminal stream). Bounds the wait even when liveness keeps getting reset.
  | { readonly kind: 'deadline' }
  | { readonly kind: 'aborted'; readonly reason: unknown };

/** Drive ONE WS connection: snapshot-on-open, stream events, liveness, abort. Resolves an outcome. */
function runWsConnection(
  events: EventTransport,
  wsUrl: string,
  validatedBase: string,
  token: string,
  a: DriverArgs,
): Promise<ConnOutcome> {
  const { ctx, leaseUuid, signal, emit, deadlineAt } = a;
  return new Promise<ConnOutcome>((resolve) => {
    const sock = events.open(wsUrl);
    let settled = false;
    let livenessTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = signal
      ? () => finish({ kind: 'aborted', reason: signal.reason })
      : undefined;

    // Overall-deadline backstop: bounds THIS connection by the caller's `timeout`, independent of
    // liveness. Liveness (armed at connection start below) bounds a silent/hung socket to ~45s per
    // attempt, but a chatty-but-never-terminal stream keeps RESETTING liveness forever — so without this
    // absolute-deadline timer such a stream would run until (or beyond) the between-attempts deadline check.
    const deadlineTimer = setTimeout(
      () => finish({ kind: 'deadline' }),
      Math.max(0, deadlineAt - Date.now()),
    );

    const finish = (outcome: ConnOutcome): void => {
      if (settled) return;
      settled = true;
      if (livenessTimer) clearTimeout(livenessTimer);
      clearTimeout(deadlineTimer);
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

    /** Classify a PROVIDER-AUTHORED status: resolve the attempt if terminal, else report progress. */
    const consider = (status: FredLeaseStatus): void => {
      if (settled) return; // never emit / resolve twice from a frame that lands after finish()
      a.observed.lastProvisionStatus = status.provision_status;
      if (classifyTerminal(status, leaseUuid) !== 'pending') {
        finish({ kind: 'terminal', status });
        return;
      }
      emit(status);
    };

    // COALESCE, DON'T DROP (the workqueue rule). One confirm-read in flight at a time, so a burst of
    // terminal-candidate frames cannot fan out into a burst of GETs — but the newest candidate is
    // KEPT and processed when that read finishes, never discarded.
    //
    // `candidateSeq` bumps on every candidate frame. A status read captures it before issuing and
    // refuses to settle the wait if it changed while the read was in flight: its evidence has been
    // superseded by a frame the provider sent later. Without that, a `ready` read issued at t0 could
    // return the pre-transition document at t2 and resolve SUCCESS even though a `failed`/`retained`
    // frame arrived at t1 — resolving success on stale evidence, which is this ticket's whole defect
    // wearing a different hat. The rule covers snapshot-on-open too, which is the read most likely to
    // be stale because it is issued earliest.
    let confirming = false;
    let candidateSeq = 0;
    let pendingCandidate: FredWsEvent | undefined;

    /**
     * A terminal-candidate frame decides only WHEN to classify, never WHAT the state is. Read the
     * authoritative `/status` and classify THAT, so both transports feed the one classifier from the
     * one input type and cannot diverge (ENG-651).
     *
     * FALLBACK ON READ FAILURE IS ASYMMETRIC, deliberately:
     *  - a PROVISION_FAILED frame is self-sufficient. It is a terminal-negative signal carrying its
     *    own failure detail, a re-read could only confirm it, and honouring it preserves the ENG-638
     *    `error` → `message`/`last_error` mapping exactly.
     *  - anything else (`ready`, `retained`, or a status this client does not recognize) is NOT
     *    self-sufficient: the frame cannot distinguish a live lease from a closed one, which is the
     *    whole defect. Do not resolve. Keep streaming — liveness → reconnect → snapshot-on-open →
     *    poll fallback is already the retry ladder, so no inner retry loop is needed here.
     */
    const confirmViaStatus = (ev: FredWsEvent): void => {
      candidateSeq += 1;
      pendingCandidate = ev; // newest wins; an older unprocessed candidate is worthless
      if (confirming) return; // the in-flight loop will pick it up
      confirming = true;
      void (async () => {
        try {
          while (!settled && pendingCandidate !== undefined) {
            const candidate = pendingCandidate;
            const seq = candidateSeq;
            pendingCandidate = undefined; // claimed
            let snap: FredLeaseStatus | undefined;
            try {
              snap = await getLeaseStatus(
                validatedBase,
                leaseUuid,
                token,
                ctx.fetch,
                signal,
                ctx.allowLoopback,
              );
            } catch {
              // Read failed. Honour the frame only if it is self-sufficient AND still the newest
              // thing we know; otherwise loop and let the newer candidate drive its own read.
              if (
                !settled &&
                candidateSeq === seq &&
                PROVISION_FAILED.has(candidate.status)
              ) {
                consider(mapWsEventToStatus(candidate));
              }
              continue;
            }
            if (settled) return;
            if (candidateSeq !== seq) continue; // superseded mid-read → discard, re-read
            consider(snap);
          }
        } finally {
          confirming = false;
        }
      })();
    };

    if (signal)
      signal.addEventListener('abort', onAbort as () => void, { once: true });
    if (signal?.aborted) {
      finish({ kind: 'aborted', reason: signal.reason });
      return;
    }

    // Arm liveness immediately (not just on open) so a socket that never opens (e.g. a silently dropped
    // handshake) is torn down + retried within the window instead of hanging until the overall deadline.
    resetLiveness();

    sock.onOpen(() => {
      resetLiveness();
      // The WS stream only carries FUTURE transitions; snapshot the current state once so an
      // already-terminal / already-ready lease resolves immediately (best-effort — keep streaming on error).
      void (async () => {
        const seq = candidateSeq;
        try {
          const snap = await getLeaseStatus(
            validatedBase,
            leaseUuid,
            token,
            ctx.fetch,
            signal,
            ctx.allowLoopback,
          );
          // Same supersession rule as the confirm-read: a candidate frame that arrived while this
          // snapshot was in flight describes a LATER state, so this document must not settle the
          // wait. Its own confirm-read is authoritative; drop this one.
          if (!settled && candidateSeq === seq) consider(snap);
        } catch {
          /* snapshot best-effort */
        }
      })();
    });

    sock.onMessage((data) => {
      if (settled) return; // ignore frames delivered during/after the close handshake
      resetLiveness();
      const ev = parseFredWsEvent(data);
      if (!ev) return;
      // A KNOWN in-progress status can only mean "still working on a live lease", so the frame is
      // sufficient on its own and stays a pure progress event — no round trip on the hot path.
      // Everything else could settle the wait, and the frame carries no chain state, so it triggers
      // an authoritative read instead of being trusted (ENG-651).
      if (PROVISION_IN_PROGRESS.has(ev.status)) {
        consider(mapWsEventToStatus(ev));
        return;
      }
      confirmViaStatus(ev);
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
    // The overall deadline elapsed mid-connection — reject with the timeout (do NOT reconnect or poll;
    // a fall-through to polling could otherwise resolve AFTER the documented deadline).
    if (outcome.kind === 'deadline')
      throw timedOutError(
        leaseUuid,
        a.timeoutMs,
        a.observed.lastProvisionStatus,
      );
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
 * only, deduped unless `emitEvery`.
 *
 * The transport changes LATENCY, never the VERDICT. A WS frame carries a provision status and no
 * chain state, so it is treated as a trigger: a frame that could settle the wait causes an
 * authoritative `/status` read, and that provider-authored document is what gets classified. Both
 * transports therefore reach `classifyTerminal` with the same kind of input. The one exception is a
 * PROVISION_FAILED frame whose read failed, which resolves from the frame — a terminal-negative
 * signal is self-sufficient, while a success-shaped one is not (ENG-651).
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
    timeoutMs,
    deadlineAt: Date.now() + timeoutMs,
    emit,
    observed: {},
  };

  if (ctx.events) {
    try {
      return await waitViaWs(args);
    } catch (err) {
      // A deliberate abort is never downgraded to a poll — surface it.
      if (signal?.aborted) throw signal.reason;
      // If the overall deadline already elapsed, reject with the timeout — do NOT fall back to polling
      // (a poll could resolve AFTER the documented deadline).
      if (Date.now() >= args.deadlineAt)
        throw timedOutError(
          leaseUuid,
          timeoutMs,
          args.observed.lastProvisionStatus,
        );
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
