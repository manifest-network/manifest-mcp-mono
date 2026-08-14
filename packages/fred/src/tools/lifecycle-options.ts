import type { PollOptions } from '../http/fred.js';
import type { CancellableOptions } from './call-signal.js';

/**
 * Runtime options for the provider-lifecycle ops (restartApp / restoreApp / updateApp).
 * Mirrors deployManifest's DeployCallOptions, minus the chain-tx-only fields.
 *
 * Cancellation is `signal` + `timeout` (inherited from core's `CallOptions`); the
 * legacy `abortSignal` is deprecated but still honoured. It is checked via
 * `throwIfAborted()` BEFORE the mutate POST and threaded into the poll. The in-flight
 * mutate POST itself is not abortable (a non-idempotent restart/update POST can't be
 * safely un-sent) — cancellation takes effect before the POST or during the poll.
 *
 * `restoreApp` is the exception worth knowing: it broadcasts a credit-reserving
 * create-lease before its POST, so a cancel landing after that broadcast rolls the
 * fresh lease back rather than propagating a bare `AbortError` (ENG-666).
 */
export interface LifecycleCallOptions extends CancellableOptions {
  /**
   * Fast path. Caller asserts an already-resolved, ACTIVE lease reachable at this
   * provider URL. When set, skip BOTH on-chain round-trips (fetchActiveLease +
   * resolveProviderUrl) and call the provider directly. The SSRF/format guard is NOT
   * bypassed — restartLease/updateLease still run validateProviderUrl (honoring the
   * server's allowLoopback) on this URL.
   * The ACTIVE precondition is delegated to the provider (authoritative) + the default poll.
   */
  readonly providerUrl?: string;
  /**
   * Poll-to-ready control. DEFAULT (undefined) = poll to ready. Pass `false` to opt out
   * (fire-and-return). An object customizes the poll (intervalMs/timeoutMs/onProgress/checkChainState).
   */
  readonly pollOptions?: Omit<PollOptions, 'abortSignal'> | false;
}
