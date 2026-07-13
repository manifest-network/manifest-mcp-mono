// Node-only entry — the SSRF-safe-by-default fred client factory. Lives behind fred's `./node`
// subpath ({node, default:null}) so a browser bundle never resolves it (it imports core's
// node-only guarded fetch). Re-exported from the SDK's `/node` subpath.
// Import order is biome-sorted: base package before its /guarded-fetch subpath, then relative.
import { createGuardedFetch } from '@manifest-network/manifest-mcp-core/guarded-fetch';
import {
  type CreateFredClientOptions,
  createFredClient,
  type FredClient,
} from './client.js';

/**
 * Node-only: like {@link createFredClient} but SSRF-safe by default — provider HTTP runs through an
 * SSRF-guarded fetch unless you inject your own `fetch` (which opts OUT of the guard). Always guards;
 * does NOT read `MANIFEST_FRED_FETCH_GUARDED` (that env knob is MCP-server-only — the library escape
 * hatch is `opts.fetch`). `allowLoopback` (default false) is forwarded to createFredClient.
 */
export async function createFredClientNode(
  opts: CreateFredClientOptions,
): Promise<FredClient> {
  return createFredClient({
    ...opts,
    fetch: opts.fetch ?? createGuardedFetch(),
  });
}
