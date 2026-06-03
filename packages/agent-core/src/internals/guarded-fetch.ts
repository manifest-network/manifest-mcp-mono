/**
 * SSRF-guarded `fetch` factory.
 *
 * The implementation was moved to `@manifest-network/manifest-mcp-core`
 * (ENG-268) so that `packages/fred` — which depends on `core`, not
 * `agent-core` — can share one guard instead of duplicating the
 * security-sensitive undici dispatcher. This module re-exports it to
 * preserve agent-core's existing import paths (e.g. `inspect-image.ts`).
 *
 * Imported from core's Node-only `/guarded-fetch` subpath rather than the
 * package barrel: the barrel must stay browser-bundleable, so the
 * undici-backed guard is no longer re-exported from it (ENG-281).
 */
export {
  BLOCKED_RANGES_IPV4,
  BLOCKED_RANGES_IPV6,
  createGuardedFetch,
  type GuardedFetch,
  isBlocked,
} from '@manifest-network/manifest-mcp-core/guarded-fetch';
