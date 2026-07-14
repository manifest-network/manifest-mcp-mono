/**
 * Node-only entry point for the SSRF-guarded WebSocket transport backing `ctx.events` (ENG-315).
 *
 * Exposed as the `@manifest-network/manifest-mcp-core/events-node` subpath (NOT the universal barrel
 * `index.ts`) so browser consumers importing the package root never drag `ws` (an optional Node
 * dependency this transport dynamic-imports) into their bundle graph — the exact mirror of
 * `/guarded-fetch`. Browser consumers inject an EventTransport backed by the native `WebSocket` instead.
 *
 * `createNodeEventTransport` throws on non-Node runtimes by construction; the subpath is Node-only by
 * contract (`package.json` `exports` gates it behind the `node` condition with `default: null`).
 */
export {
  createNodeEventTransport,
  type NodeEventTransportOptions,
} from './internals/event-transport-node.js';
