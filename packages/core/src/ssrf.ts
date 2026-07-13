/**
 * Universal (browser-safe) SSRF IP-classification primitives, exposed as
 * `@manifest-network/manifest-mcp-core/ssrf`.
 *
 * Contrast with `./guarded-fetch` (node-gated): that subpath carries the
 * undici-backed connect-time FETCH FACTORY, which needs node:*. This subpath
 * carries only the PURE classifier (ipaddr.js), so it is safe to import from
 * browser bundles — fred's `isUrlSsrfSafe` uses it. Kept OFF the package
 * barrel (`index.ts`) deliberately: it is a low-level primitive, and the
 * `exports` field's encapsulation keeps the SDK root surface minimal.
 */
export {
  BLOCKED_RANGES_IPV4,
  BLOCKED_RANGES_IPV6,
  isBlocked,
  isIpLiteral,
} from './internals/ssrf-classify.js';
