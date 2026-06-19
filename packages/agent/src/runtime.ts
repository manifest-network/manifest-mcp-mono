/**
 * `AgentCoreRuntime` builder for the wrapper.
 *
 * The shared runtime is constructed once per server (lazy `fetchFn`
 * load) and spread into each per-call options object. Per-call extras
 * — `chainDataFile` / `denomMap` / `dataDir` — live in `index.ts`
 * because they vary by env-var visibility and per-tool relevance.
 *
 * `createGuardedFetch` is imported **dynamically** from agent-core's
 * Node-only `/guarded-fetch` subpath, behind the
 * `MANIFEST_AGENT_FETCH_GUARDED=1` env-var gate. The subpath is fenced
 * off the `.` barrel (ENG-281/287) so the barrel stays
 * browser-bundleable; importing it dynamically also defers the
 * `createGuardedFetch()` *invocation* and the `undici` + Node-builtin
 * dynamic imports the factory does internally — so an operator who
 * leaves the guard off pays no runtime cost from the guarded-fetch
 * path.
 */

import type { AgentCoreRuntime } from '@manifest-network/manifest-agent-core';
import type { CosmosClientManager } from '@manifest-network/manifest-mcp-core';

export interface BuildRuntimeArgs {
  readonly clientManager: CosmosClientManager;
  /**
   * When `true`, replace `globalThis.fetch` with the SSRF-guarded
   * variant exported by
   * `@manifest-network/manifest-agent-core/guarded-fetch`. The import is
   * dynamic so the platform-neutral build stays legal. Operators flip
   * this via `MANIFEST_AGENT_FETCH_GUARDED=1`.
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
      '@manifest-network/manifest-agent-core/guarded-fetch'
    );
    fetchFn = createGuardedFetch();
  }
  return {
    clientManager: args.clientManager,
    ...(fetchFn ? { fetchFn } : {}),
  };
}
