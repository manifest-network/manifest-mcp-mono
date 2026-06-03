/**
 * Node-only entry point for the SSRF-guarded `fetch` factory.
 *
 * Exposed as the `@manifest-network/manifest-mcp-core/guarded-fetch` subpath
 * (NOT from the universal barrel `index.ts`) so browser consumers importing
 * the package root never drag `undici` — which `internals/guarded-fetch.ts`
 * dynamic-imports and which transitively requires `node:async_hooks` — into
 * their bundle graph (ENG-281). Server consumers (fred, agent-core) import
 * this subpath explicitly.
 *
 * `createGuardedFetch` throws on non-Node runtimes by construction; the
 * subpath is Node-only by contract (`package.json` `exports` gates it behind
 * the `node` condition).
 */
export {
  BLOCKED_RANGES_IPV4,
  BLOCKED_RANGES_IPV6,
  createGuardedFetch,
  type GuardedFetch,
  isBlocked,
} from './internals/guarded-fetch.js';
