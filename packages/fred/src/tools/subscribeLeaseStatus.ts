import {
  type CapabilityCtx,
  type FredLeaseStatus,
  LeaseState,
  type LeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
  requireAuthSigner,
} from '@manifest-network/manifest-mcp-core';
import { createAuthTokens } from '../http/auth-tokens-factory.js';
import {
  getLeaseStatus,
  PROVISION_FAILED,
  PROVISION_IN_PROGRESS,
} from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

/** The capability slice subscribeLeaseStatus needs: query (provider lookup) + chain (rate limit +
 *  chainId) + fetch (provider HTTP) + signer (ADR-036 status token). `logger` and `events` are NOT
 *  used by the current poll-backed body — both are carried as forward-compat for the deferred WS
 *  transport (`events` = the eventual subscription source; `logger` = per-poll/terminal diagnostics). */
export type SubscribeCtx = Pick<
  CapabilityCtx,
  'query' | 'chain' | 'fetch' | 'signer' | 'logger' | 'events'
>;

export interface SubscribeLeaseStatusOptions {
  /** Each (deduped) observed status, branded. */
  onData: (status: FredLeaseStatus) => void;
  /** Terminal reached (success OR observed lease-failure). Fires ONCE with the final status, then auto-unsubscribe. */
  onComplete?: (final: FredLeaseStatus) => void;
  /** ABNORMAL stop only: poll timeout, network, parse-failure. NOT lease-failure (→ onComplete), NOT abort (→ silent). */
  onError?: (err: unknown) => void;
  /** Caller cancellation ≡ unsubscribe: silent stop, no onError, no onComplete. */
  signal?: AbortSignal;
  /** Poll DEADLINE in ms (default 120000, matches pollLeaseUntilReady). Reaching it on a non-terminal lease → onError. */
  timeout?: number;
  /** Poll interval in ms (default 3000). */
  intervalMs?: number;
  /** false (default) = dedup onData on (state, provision_status); true = raw per-poll emit. */
  emitEvery?: boolean;
}

/**
 * Local abortable sleep — rejects when `signal` aborts (so an abort during the interval unsubscribes).
 * Intentionally a private copy, NOT the `abortableSleep` in `http/fred.ts` (which is also file-local and
 * unexported): that sibling takes an OPTIONAL signal (plain sleep when absent) for `pollLeaseUntilReady`;
 * this watch's signal is always present and is the canonical helper for `subscribeLeaseStatus`. Keeping
 * them separate avoids a cross-file signature reconciliation that could perturb `pollLeaseUntilReady`.
 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Terminal classification, mirroring pollLeaseUntilReady (fred.ts:374-409) but returning a verdict
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

/**
 * Watch a lease's Fred provision status by polling the provider's /v1/leases/{uuid}/status endpoint
 * (full FredLeaseStatus — provision_status/phase/instances/endpoints, which chain getLease cannot
 * observe; §5.9). A CONVERGING watch: it ALWAYS ends in exactly one of {onComplete, onError, silent
 * abort} then auto-unsubscribes. Terminal-success OR observed terminal-failure → final onData +
 * onComplete (a watched outcome is a value); the poll DEADLINE (stuck non-terminal lease) + network/
 * parse errors → onError; a caller `signal` abort → silent stop. onData dedups on (state,
 * provision_status) unless emitEvery. Returns a synchronous, idempotent unsubscribe. Poll-backed in P0
 * (ctx.events WS transport deferred). Typed-face only. (viem watch* SHAPE + Cosmos converging SEMANTICS.)
 */
export function subscribeLeaseStatus(
  ctx: SubscribeCtx,
  leaseUuid: LeaseUuid,
  opts: SubscribeLeaseStatusOptions,
): () => void {
  // Caller cancellation ONLY. `opts.timeout` is the abnormal poll DEADLINE handled in-loop (→ onError),
  // distinct from a caller abort (→ silent) — so do NOT fold opts.timeout into this signal.
  const controller = new AbortController();
  const abortSignal = opts.signal
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;
  const intervalMs = opts.intervalMs ?? 3_000;
  const timeoutMs = opts.timeout ?? 120_000;

  let stopped = false;
  const unsubscribe = (): void => {
    if (stopped) return; // idempotent
    stopped = true;
    controller.abort();
  };

  // Dedup over (state, provision_status); the terminal status always emits (force) even if unchanged.
  let lastKey: string | undefined;
  const emit = (status: FredLeaseStatus, force = false): void => {
    const key = `${status.state}|${status.provision_status ?? ''}`;
    if (force || opts.emitEvery || key !== lastKey) {
      lastKey = key;
      opts.onData(status);
    }
  };

  void (async () => {
    let providerUrl: string;
    // ADR-036 status token (getAuthToken, the appStatus pattern — NOT getLeaseDataAuthToken). Built
    // INSIDE the setup try (N1): requireAuthSigner throws synchronously on a signer-less ctx, and the
    // contract is a synchronous, never-throwing unsubscribe return — so a signer-less ctx must surface
    // via onError, not by throwing out of subscribeLeaseStatus. signer is present on the full fred
    // client; re-minted per poll (replay-tracker safe; fresh-per-call).
    let tokens: ReturnType<typeof createAuthTokens>;
    try {
      tokens = createAuthTokens(requireAuthSigner(ctx), {
        chainId: ctx.chain.getConfig().chainId,
      });
      await ctx.chain.acquireRateLimit();
      const leaseRes = await ctx.query.liftedinit.billing.v1.lease({
        leaseUuid,
      });
      if (!leaseRes.lease) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Lease "${leaseUuid}" not found on chain`,
        );
      }
      providerUrl = await resolveProviderUrl(
        ctx.query,
        leaseRes.lease.providerUuid,
      );
    } catch (err) {
      if (!stopped && !abortSignal.aborted) opts.onError?.(err);
      return; // setup failure — cannot poll without a provider URL (abnormal → onError)
    }

    const deadlineAt = Date.now() + timeoutMs;
    while (!stopped && !abortSignal.aborted) {
      let status: FredLeaseStatus;
      try {
        const token = await tokens.getAuthToken(leaseUuid);
        status = await getLeaseStatus(providerUrl, leaseUuid, token, ctx.fetch);
      } catch (err) {
        if (stopped || abortSignal.aborted) return; // abort during the await ≡ silent unsubscribe
        opts.onError?.(err); // abnormal (network/parse) → onError + STOP
        return;
      }
      if (stopped || abortSignal.aborted) return;

      const terminal = classifyTerminal(status);
      if (terminal !== 'pending') {
        emit(status, true); // ALWAYS emit the terminal status (bypass dedup)
        stopped = true;
        opts.onComplete?.(status); // success OR observed failure — both complete (failure is a value)
        return;
      }
      emit(status); // non-terminal: dedup-aware
      if (Date.now() >= deadlineAt) {
        opts.onError?.(
          new ManifestMCPError(
            ManifestMCPErrorCode.QUERY_FAILED,
            `subscribeLeaseStatus timed out after ${timeoutMs}ms; lease ${leaseUuid} still non-terminal`,
          ),
        );
        return; // stuck non-terminal lease is LOUD (abnormal → onError), not a quiet done
      }
      try {
        await abortableSleep(intervalMs, abortSignal);
      } catch {
        return; // abort during the interval ≡ silent unsubscribe (no onError/onComplete)
      }
    }
  })();

  return unsubscribe;
}
