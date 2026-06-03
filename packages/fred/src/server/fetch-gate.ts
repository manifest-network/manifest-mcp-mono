import { logger, parseBooleanEnv } from '@manifest-network/manifest-mcp-core';
// Node-only SSRF guard lives on a dedicated subpath so the core barrel stays
// browser-bundleable (ENG-281).
import { createGuardedFetch } from '@manifest-network/manifest-mcp-core/guarded-fetch';

/**
 * Env var gating fred's SSRF-guarded fetch. Default ON; operators opt out
 * with `MANIFEST_FRED_FETCH_GUARDED=0`. Independent of the agent server's
 * `MANIFEST_AGENT_FETCH_GUARDED` so each standalone server can be toggled
 * on its own (ENG-268).
 */
export const FRED_FETCH_GUARDED_ENV = 'MANIFEST_FRED_FETCH_GUARDED';

/**
 * Decide which `fetch` the fred MCP server injects into its tool layer.
 *
 * - Guard ON (default) + Node runtime → an SSRF-guarded fetch (blocks
 *   provider URLs that resolve to private/reserved ranges; closes the
 *   DNS-rebinding window at connect time).
 * - Guard ON + non-Node runtime → `undefined` (so the HTTP layer falls back
 *   to `globalThis.fetch`), with a warning — `createGuardedFetch` is
 *   Node-only and would otherwise throw.
 * - Guard OFF (`MANIFEST_FRED_FETCH_GUARDED=0`) → `undefined` (unguarded
 *   `globalThis.fetch` fallback).
 * - Unrecognized env value → throws `INVALID_CONFIG` (never silently
 *   disables the guard).
 *
 * Returning `undefined` rather than `globalThis.fetch` keeps the injection
 * a no-op for the HTTP layer's existing `fetchFn = globalThis.fetch`
 * default, so library consumers that pass their own `fetchFn` are
 * unaffected.
 *
 * @param envValue - Raw `MANIFEST_FRED_FETCH_GUARDED` value.
 * @param isNode - Whether the current runtime is Node.js.
 */
export function resolveGuardedFetch(
  envValue: string | undefined,
  isNode: boolean,
): typeof globalThis.fetch | undefined {
  const guarded = parseBooleanEnv(envValue, true, FRED_FETCH_GUARDED_ENV);
  if (!guarded) return undefined;
  if (isNode) return createGuardedFetch();
  logger.warn(
    `${FRED_FETCH_GUARDED_ENV} is enabled but the runtime is not Node.js; ` +
      'the SSRF guard is unavailable — falling back to globalThis.fetch.',
  );
  return undefined;
}
