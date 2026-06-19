/**
 * Node-only SSRF-guarded fetch, fenced off the package barrel (ENG-281/287 pattern) so the `.`
 * barrel stays browser-bundleable. Re-exported from the in-package internals re-export, which itself
 * pulls core's Node-gated `/guarded-fetch`. Consumers import this via
 * `@manifest-network/manifest-agent-core/guarded-fetch`.
 */
export {
  BLOCKED_RANGES_IPV4,
  BLOCKED_RANGES_IPV6,
  createGuardedFetch,
  type GuardedFetch,
  isBlocked,
} from './internals/guarded-fetch.js';
