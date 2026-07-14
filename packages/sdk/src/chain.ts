// `/chain` subpath — the tier-2 generic-chain escape hatches: a raw query + a raw
// tx, re-exported from `core` (NOT the `manifest-mcp-chain` server package). These
// are the SDK-level equivalent of the chain server's `cosmos_query`/`cosmos_tx`
// tools. Grouped together on one honest subpath (generic-op → generic subpath),
// mirroring viem's `./actions` co-locating generic reads + writes.
export {
  cosmosQuery,
  cosmosTx,
} from '@manifest-network/manifest-mcp-core';
