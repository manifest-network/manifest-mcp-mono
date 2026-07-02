// `/node` subpath — the ONLY node-only SDK entry. Re-exports core's SSRF-guarded fetch and the
// SSRF-safe-by-default `createFredClientNode` factory (which auto-injects that guard). Mapped
// `{types,node,default:null}` so a browser bundler that walks this entry hits `default:null` and
// never pulls `undici`/`node:async_hooks` (browser-safety; ENG-281/287).
export {
  createGuardedFetch,
  type GuardedFetch,
  isBlocked,
} from '@manifest-network/manifest-mcp-core/guarded-fetch';
export { createFredClientNode } from '@manifest-network/manifest-mcp-fred/node';
