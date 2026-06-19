// `/node` subpath — the ONLY node-only entry. Re-exports core's SSRF-guarded fetch from
// the Node-gated `/guarded-fetch` subpath. Mapped `{types,node,default:null}` so a browser
// bundler that walks this entry hits `default:null` and fails fast (never silently pulls
// `undici`/`node:async_hooks`). Kept off every browser-safe barrel (browser-safety; ENG-281/287).
export {
  createGuardedFetch,
  type GuardedFetch,
  isBlocked,
} from '@manifest-network/manifest-mcp-core/guarded-fetch';
