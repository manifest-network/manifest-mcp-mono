import type { PollOptions } from '../http/fred.js';

/**
 * Runtime options for the provider-lifecycle ops (restartApp / updateApp).
 * Mirrors deployManifest's DeployCallOptions, minus the chain-tx-only fields
 * (these ops perform no chain transactions).
 */
export interface LifecycleCallOptions {
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
   * Cancels the op. Checked via `throwIfAborted()` BEFORE the mutate POST and threaded
   * into the poll. The in-flight mutate POST itself is not abortable (a non-idempotent
   * restart/update POST can't be safely un-sent) — abort takes effect before the POST or
   * during the poll.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Poll-to-ready control. DEFAULT (undefined) = poll to ready. Pass `false` to opt out
   * (fire-and-return). An object customizes the poll (intervalMs/timeoutMs/onProgress/checkChainState).
   */
  readonly pollOptions?: Omit<PollOptions, 'abortSignal'> | false;
}
