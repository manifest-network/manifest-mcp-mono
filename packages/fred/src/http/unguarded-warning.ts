// Shared "provider HTTP is unguarded" warning, used by BOTH unguarded entry points:
// `createFredClient` (warns at construction) and the shared HTTP transport (warns on the first call
// whose fetch was omitted or defaulted by core). Lives here rather than in `client.ts` because
// `http/provider.ts` must reach it and `client.ts` imports `http/` — the reverse edge would be a cycle.
//
// Layer 2 of the SSRF defence (core's `createGuardedFetch`) is opt-in per entry point: the MCP
// servers and `createFredClientNode` inject it; the base `createFredClient` and the raw HTTP
// functions on the fred barrel / SDK `/deploy` fall back to `globalThis.fetch`. That fallback used
// to be silent on the raw-function path, which is what this module fixes. See `docs/security.md`
// ("Layer 2 activation") for the full matrix.
import {
  isClientDefaultFetch,
  logger,
} from '@manifest-network/manifest-mcp-core';

/**
 * Pure predicate: should we warn that provider HTTP is running unguarded? True only on Node
 * (`isNode`) when the caller supplied no custom `fetch` — in a browser there is no connect guard
 * to be missing (layer 1 plus the platform's Private Network Access / CORS apply instead), and an
 * explicit injection is a deliberate opt-out whose guardedness this package cannot infer.
 *
 * `isNode` is a parameter so the browser-negative case is unit-testable.
 * Not part of the public SDK surface (not re-exported from the fred barrel).
 */
export function shouldWarnUnguarded(
  hasCustomFetch: boolean,
  isNode: boolean,
): boolean {
  return !hasCustomFetch && isNode;
}

/**
 * Runtime probe. A plain `typeof` check rather than a `node:` import so this module stays
 * isomorphic — it is reachable from the browser-safe fred barrel.
 */
export function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

/**
 * Did the caller explicitly supply a fetch rather than omit the transport?
 *
 * Core's client factories turn an omitted option into a required `ctx.fetch` function, so nullishness
 * alone loses the distinction. Core owns that composition invariant and provenance-tags only its
 * default wrapper; {@link isClientDefaultFetch} recovers it even if `globalThis.fetch` is later
 * replaced. Any other function — including an explicitly passed platform global, bound wrapper or
 * real guarded fetch — is custom by contract. A plain-JS caller can also pass `null`; because `??`
 * falls back to the platform global, that remains omitted/unguarded.
 */
export function hasCustomFetch(
  fetchFn: typeof globalThis.fetch | null | undefined,
): boolean {
  return (
    fetchFn !== undefined && fetchFn !== null && !isClientDefaultFetch(fetchFn)
  );
}

export const UNGUARDED_FETCH_WARNING =
  'manifest-mcp-fred: provider HTTP is running through an unguarded fetch on Node. ' +
  'Provider URLs come from on-chain SKU records, so this is an SSRF surface — without the ' +
  'connect-time guard, a provider hostname that DNS-resolves to an internal address is not blocked. ' +
  "Use createFredClientNode from '@manifest-network/manifest-mcp-fred/node' " +
  "(re-exported by the SDK as '@manifest-network/manifest-sdk/node'; SSRF-safe by default), " +
  "or pass a guarded fetch from createGuardedFetch ('@manifest-network/manifest-mcp-core/guarded-fetch') " +
  'as `opts.fetch` on createFredClient or as the `fetchFn` argument of a raw HTTP function. ' +
  'Note: explicitly injecting any fetch opts OUT of the automatic SSRF guard and this ' +
  'missing-guard warning; injection alone does not make that fetch guarded.';

// Module-level once-latch SHARED by every unguarded entry point, so a process emits this at most
// once however many clients it builds or raw calls it makes (isolated in tests via
// `vi.resetModules()`). One warning is a signal; one per HTTP call would be noise the caller learns
// to filter out.
let warned = false;

/**
 * Emit {@link UNGUARDED_FETCH_WARNING} at most once per process, if warranted.
 *
 * @param hasCustomFetch - Whether the caller explicitly supplied a fetch (which opts out of the guard).
 * @param isNode - Runtime probe; defaults to {@link isNodeRuntime}. Injectable for tests.
 */
export function warnUnguardedOnce(
  hasCustomFetch: boolean,
  isNode: boolean = isNodeRuntime(),
): void {
  if (warned || !shouldWarnUnguarded(hasCustomFetch, isNode)) return;
  warned = true;
  logger.warn(UNGUARDED_FETCH_WARNING);
}
