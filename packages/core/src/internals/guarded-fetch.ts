/**
 * SSRF-guarded `fetch` factory. A Node-native undici Dispatcher that
 * DNS-resolves once at connect time and rejects any address whose
 * `ipaddr.js` range is not `'unicast'`.
 *
 * Why DIY rather than `request-filtering-agent`: the library only works with
 * `http`/`https`.Agent (legacy http API) and explicitly does NOT plug into
 * undici / native `fetch` per its v3.2.0 README. Re-routing the same
 * blocking semantics through undici's Dispatcher hook lets agent-core's
 * `inspectImage` (and future consumers) use native `fetch` while preserving
 * the same SSRF posture.
 *
 * Design (architect-blessed):
 * - **IP classification** (the non-`unicast` range check + IPv4-mapped
 *   normalization) and the `BLOCKED_RANGES_*` audit lists are delegated to
 *   `isBlocked` — see `./ssrf-classify.ts`.
 * - **DNS-resolve INSIDE the connect hook** to close the TOCTOU window
 *   between resolve and TCP connect. The resolved IP gets substituted as
 *   the connect hostname so the kernel doesn't re-resolve.
 * - **Module-level singleton Dispatcher**, lazy-instantiated on first
 *   `createGuardedFetch()` invocation. Mirrors the CJS singleton-agent
 *   pattern; avoids the aggressive `setGlobalDispatcher()` side-effect.
 * - **Construction-time runtime check** (`typeof process === 'undefined'`)
 *   throws a clear error on browser/Deno so the failure is actionable, not
 *   a confusing mid-fetch module-resolution error.
 * - **Redirect safety:** undici re-fires the connect hook on every cross-
 *   host redirect; same-host redirects reuse the checked socket. The fetch
 *   closure does NOT need `redirect: 'manual'` — default `follow` is safe
 *   by construction.
 *
 * Cross-platform note: core's `tsdown.config.ts` targets
 * `platform: 'neutral'`. `ipaddr.js` is isomorphic (pure JS, no node:*
 * imports), so the static import is fine. `undici` is Node-only —
 * dynamic-imported INSIDE the lazy singleton creation; `node:dns/promises`
 * + `node:net` are dynamic-imported inside `assertUnicastHost`
 * (`./ssrf-resolve.ts`). So the package stays importable from browsers /
 * Deno (calling `createGuardedFetch()` from those throws the
 * construction-time error with actionable guidance).
 */

// The IP classifier lives in `ssrf-classify.ts` (ENG-490) and the DNS-resolve + unicast assertion in
// `ssrf-resolve.ts` (ENG-315, shared with the WebSocket transport). Re-exported here so the Node-only
// `@manifest-network/manifest-mcp-core/guarded-fetch` subpath keeps its historical shape.
export {
  BLOCKED_RANGES_IPV4,
  BLOCKED_RANGES_IPV6,
  isBlocked,
} from './ssrf-classify.js';

import { assertUnicastHost } from './ssrf-resolve.js';

export type GuardedFetch = typeof fetch;

interface DispatcherCache {
  dispatcher: unknown;
  fetch: typeof fetch;
}

/**
 * Cache the in-flight Promise (not the resolved value) so concurrent first-
 * call racers share the same construction and don't double-build the
 * undici Agent. Resolves to the singleton DispatcherCache. After
 * resolution, subsequent calls await the already-settled Promise (cheap).
 */
let cachedP: Promise<DispatcherCache> | undefined;

/**
 * Build the SSRF-guarded fetch closure. Construction-time runtime check
 * gates Node-only — browser / Deno consumers either pass their own
 * `opts.fetch` to consumers like `inspectImage` or accept this error.
 *
 * The returned function matches `typeof fetch` and lazy-instantiates the
 * undici Dispatcher on first invocation. Subsequent calls share the
 * cached singleton.
 *
 * **Important: uses undici's own `fetch`**, not Node's built-in. Node's
 * built-in fetch is backed by its bundled undici, which is pinned to
 * Node's release-cycle version (Node 22 → undici 6.x). The npm-installed
 * `undici` package may be newer, and the Dispatcher protocol between
 * versions isn't guaranteed compatible (we observed "invalid
 * onRequestStart method" when mixing Node 22's fetch with undici@8 Agent).
 * Routing through undici's own fetch (same package version as the Agent)
 * sidesteps the mismatch. The function signature stays identical to
 * Node's `fetch` so consumers can't tell the difference.
 */
export function createGuardedFetch(): GuardedFetch {
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error(
      'createGuardedFetch requires a Node.js runtime. On browser/Deno consumers, pass `opts.fetch` directly with your own SSRF-guarded implementation. See the @manifest-network/manifest-mcp-core README.',
    );
  }

  return async (input, init) => {
    // Cache the Promise rather than the resolved value to dedup concurrent
    // first-call construction. Two callers racing through the lazy path
    // would otherwise both call `buildSsrfDispatcher()` and end up with
    // two undici Agents (no correctness bug, just double resource).
    //
    // Catch-and-reset on rejection: if `buildSsrfDispatcher()` ever fails
    // (e.g., dynamic `import('undici')` throws on a runtime that masquerades
    // as Node but lacks the module), the rejected Promise must NOT stay
    // cached — otherwise every subsequent `createGuardedFetch()` call would
    // re-throw the same error permanently. Clearing `cachedP` in the catch
    // arm lets a future caller retry construction.
    if (!cachedP) {
      cachedP = buildSsrfDispatcher().catch((err: unknown) => {
        cachedP = undefined;
        throw err;
      });
    }
    const c = await cachedP;
    // undici's fetch accepts a `dispatcher` option natively. Cast the init
    // to undici's expected shape — undici's fetch signature is structurally
    // compatible with global fetch but TS can't see through the dispatcher
    // field without a cast.
    const initWithDispatcher = {
      ...(init ?? {}),
      dispatcher: c.dispatcher,
    } as RequestInit;
    return c.fetch(input, initWithDispatcher);
  };
}

/**
 * Lazy dynamic-import of Node-only modules so the package stays importable
 * from non-Node consumers. The runtime check in `createGuardedFetch`
 * already gates Node-only — this function is only reached on Node.
 *
 * Returns BOTH the dispatcher and undici's own `fetch` so the
 * `createGuardedFetch` closure can route through undici directly (avoiding
 * Node-bundled-undici vs npm-undici Dispatcher protocol mismatches).
 */
async function buildSsrfDispatcher(): Promise<DispatcherCache> {
  const undici = await import('undici');

  const baseConnect = undici.buildConnector({});

  const dispatcher = new undici.Agent({
    connect: (options, callback) => {
      // undici's Connect signature carries hostname + port + others. Resolve + assert the host is a
      // public unicast IP (`assertUnicastHost`, shared with the WS transport), then substitute the
      // resolved IP so the kernel doesn't re-resolve (DNS-rebinding mitigation). A blocked/unresolvable
      // host throws a descriptive `SSRF blocked: …` error — fail closed via the callback.
      const hostname = (options as { hostname?: string }).hostname ?? '';
      assertUnicastHost(hostname)
        .then((ip) =>
          baseConnect(
            { ...options, hostname: ip } as Parameters<typeof baseConnect>[0],
            callback,
          ),
        )
        .catch((err: unknown) =>
          callback(err instanceof Error ? err : new Error(String(err)), null),
        );
    },
  });

  // undici's fetch has a structurally compatible signature with global fetch.
  // Cast at the boundary; downstream consumers see `typeof fetch`.
  return {
    dispatcher,
    fetch: undici.fetch as unknown as typeof fetch,
  };
}
