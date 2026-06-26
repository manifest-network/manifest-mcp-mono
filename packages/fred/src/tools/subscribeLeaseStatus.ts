import {
  type CapabilityCtx,
  type FredLeaseStatus,
  LeaseState,
  type LeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  getLeaseStatus,
  PROVISION_FAILED,
  PROVISION_IN_PROGRESS,
} from '../http/fred.js';
import type { ProviderAuthPort } from '../http/provider-auth.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

/** The capability slice subscribeLeaseStatus needs: query (provider lookup) + chain (rate limit +
 *  chainId + broadcast address) + fetch (provider HTTP) + providerAuth (the single fred auth
 *  convention — mints the per-poll ADR-036 status token). `signer` is NOT exposed directly: it is
 *  encapsulated inside `providerAuth` (built once at the composition root), matching `FredAuthCtx`.
 *  `logger` and `events` are NOT used by the current poll-backed body — both are carried as
 *  forward-compat for the deferred WS transport (`events` = the eventual subscription source;
 *  `logger` = per-poll/terminal diagnostics). */
export type SubscribeCtx = Pick<
  CapabilityCtx,
  'query' | 'chain' | 'fetch' | 'logger' | 'events'
> & { providerAuth: ProviderAuthPort };

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

  // A consumer callback (onData/onComplete/onError) that throws synchronously
  // must NOT escape the void-ed poll IIFE as an unhandled rejection, nor break
  // the converging watch (code-review PR #102). Contain the fault as a logger
  // diagnostic — it is the consumer's bug, not a watch error, so it is NOT
  // re-routed to onError/onComplete.
  const containCallbackFault = (which: string, err: unknown): void => {
    ctx.logger.warn(
      `subscribeLeaseStatus: ${which} callback threw and was contained: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  };
  const callOnError = (err: unknown): void => {
    try {
      opts.onError?.(err);
    } catch (cbErr) {
      containCallbackFault('onError', cbErr);
    }
  };

  // Dedup over (state, provision_status); the terminal status always emits (force) even if unchanged.
  let lastKey: string | undefined;
  const emit = (status: FredLeaseStatus, force = false): void => {
    const key = `${status.state}|${status.provision_status ?? ''}`;
    if (force || opts.emitEvery || key !== lastKey) {
      lastKey = key;
      try {
        opts.onData(status);
      } catch (cbErr) {
        containCallbackFault('onData', cbErr);
      }
    }
  };

  void (async () => {
    let providerUrl: string;
    // ADR-036 status token via providerAuth (the appStatus/providerToken pattern — NOT leaseDataToken),
    // the single fred auth convention. The port is address-PARAM and FredAuthCtx hides `signer`, so the
    // broadcast address is resolved here via ctx.chain.getAddress(). Resolved INSIDE the setup try (N1):
    // a signer-less manager rejects getAddress, and the contract is a synchronous, never-throwing
    // unsubscribe return — so that failure must surface via onError, not by throwing out of
    // subscribeLeaseStatus. The token is re-minted per poll (replay-tracker safe; fresh-per-call).
    let address: string;
    try {
      await ctx.chain.acquireRateLimit();
      address = await ctx.chain.getAddress();
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
      if (!stopped && !abortSignal.aborted) callOnError(err);
      return; // setup failure — cannot poll without a provider URL (abnormal → onError)
    }

    const deadlineAt = Date.now() + timeoutMs;
    while (!stopped && !abortSignal.aborted) {
      let status: FredLeaseStatus;
      try {
        const token = await ctx.providerAuth.providerToken({
          address,
          leaseUuid,
        });
        status = await getLeaseStatus(providerUrl, leaseUuid, token, ctx.fetch);
      } catch (err) {
        if (stopped || abortSignal.aborted) return; // abort during the await ≡ silent unsubscribe
        callOnError(err); // abnormal (network/parse) → onError + STOP
        return;
      }
      if (stopped || abortSignal.aborted) return;

      const terminal = classifyTerminal(status);
      if (terminal !== 'pending') {
        emit(status, true); // ALWAYS emit the terminal status (bypass dedup)
        stopped = true;
        try {
          opts.onComplete?.(status); // success OR observed failure — both complete (failure is a value)
        } catch (cbErr) {
          containCallbackFault('onComplete', cbErr);
        }
        return;
      }
      emit(status); // non-terminal: dedup-aware
      if (Date.now() >= deadlineAt) {
        callOnError(
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
  })().finally(() => {
    // CONVERGING cleanup on EVERY exit (terminal, onError, deadline, abort, or
    // a contained callback fault): stop the watch and abort the internal
    // controller. Aborting it also detaches the `AbortSignal.any` listener from
    // a caller-provided `opts.signal`, so a self-terminated watch leaves no
    // dangling registration on a long-lived caller signal (code-review PR #102).
    stopped = true;
    controller.abort();
  });

  return unsubscribe;
}
