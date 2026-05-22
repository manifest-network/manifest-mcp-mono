/**
 * `AgentCoreRuntime` builder for the wrapper.
 *
 * The shared runtime is constructed once per server (lazy `fetchFn`
 * load) and spread into each per-call options object. Per-call extras
 * — `chainDataFile` / `denomMap` / `dataDir` — live in `index.ts`
 * because they vary by env-var visibility and per-tool relevance.
 *
 * `createGuardedFetch` is imported **dynamically** behind the
 * `MANIFEST_AGENT_FETCH_GUARDED=1` env-var gate. Note this does NOT
 * keep `ipaddr.js` out of the static module graph — agent-core's main
 * entry already re-exports `createGuardedFetch` (and therefore
 * statically imports `ipaddr.js`) the moment the wrapper imports its
 * orchestration functions. What the dynamic gate defers is the
 * `createGuardedFetch()` *invocation* and the `undici` + Node-builtin
 * dynamic imports the factory does internally — so an operator who
 * leaves the guard off pays no runtime cost from the guarded-fetch
 * path, but the dependency itself is part of the bundle.
 */

import type { AgentCoreRuntime } from '@manifest-network/manifest-agent-core';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';

export interface BuildRuntimeArgs {
  readonly clientManager: CosmosClientManager;
  /**
   * When `true`, replace `globalThis.fetch` with the SSRF-guarded
   * variant exported by `@manifest-network/manifest-agent-core`. The
   * import is dynamic so the platform-neutral build stays legal.
   * Operators flip this via `MANIFEST_AGENT_FETCH_GUARDED=1`.
   */
  readonly fetchGuarded: boolean;
}

/**
 * Build the shared `AgentCoreRuntime`. Async because the optional
 * `createGuardedFetch` import is dynamic. Callers `await` once at
 * server startup and reuse the result across tool calls.
 */
export async function buildRuntime(
  args: BuildRuntimeArgs,
): Promise<AgentCoreRuntime> {
  let fetchFn: typeof globalThis.fetch | undefined;
  if (args.fetchGuarded) {
    const { createGuardedFetch } = await import(
      '@manifest-network/manifest-agent-core'
    );
    fetchFn = createGuardedFetch();
  }
  return {
    clientManager: args.clientManager,
    ...(fetchFn ? { fetchFn } : {}),
  };
}
