import {
  type CallOptions,
  resolveCallSignal,
} from '@manifest-network/manifest-mcp-core';

/**
 * The cancellation half of a fred per-call options bag: core's canonical
 * `signal` + `timeout`, plus fred's legacy `abortSignal`.
 *
 * `signal`/`timeout` is the spelling used by core (`CallOptions`), agent-core,
 * the agent MCP server and fred's own `waitForLeaseStatus`. `abortSignal` was
 * fred-only; it is deprecated but still honoured (ENG-666).
 */
export type CancellableOptions = CallOptions & {
  /** @deprecated Use `signal`. Both are honoured — either one cancels. */
  readonly abortSignal?: AbortSignal;
};

/**
 * Resolve the one effective signal for a call, composing the canonical
 * `signal`/`timeout` with the deprecated `abortSignal`.
 *
 * Call this ONCE per operation and thread the result. A second call would mint a
 * second `AbortSignal.timeout` from the same `timeout`, so the two legs would
 * expire independently — the hazard core documents at `internals/read-signal.ts`.
 *
 * When exactly one source is present its own instance is returned unwrapped (as
 * `resolveCallSignal` does), so callers can still compare the signal by reference.
 */
export function resolveFredSignal(
  opts?: CancellableOptions,
): AbortSignal | undefined {
  const resolved = resolveCallSignal(opts);
  if (!opts?.abortSignal) return resolved;
  if (!resolved) return opts.abortSignal;
  return AbortSignal.any([resolved, opts.abortSignal]);
}
