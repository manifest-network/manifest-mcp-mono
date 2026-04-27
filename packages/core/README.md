# @manifest-network/manifest-mcp-core

Shared library for Manifest MCP servers. Contains Cosmos SDK logic, on-chain tool functions, server utilities, and the LCD/REST adapter. This package is **not** an MCP server itself -- it provides building blocks that the chain, lease, fred, and cosmwasm packages compose into servers.

## Installation

```bash
npm install @manifest-network/manifest-mcp-core
```

## What's inside

- **CosmosClientManager** (`client.ts`) -- Keyed-instance client lifecycle with rate limiting and lazy init (RPC + LCD)
- **LCD adapter** (`lcd-adapter.ts`) -- Converts LCD/REST responses to the RPC query client shape, making the codebase transport-agnostic
- **Module registry** (`modules.ts`) -- Static maps of Cosmos SDK modules with metadata and handler functions
- **Query/transaction routing** (`cosmos.ts`) -- Routes `(module, subcommand, args)` to per-module handlers
- **On-chain tool functions** (`tools/`) -- `getBalance`, `fundCredits`, `stopApp` (used by the lease package)
- **Server utilities** (`server-utils.ts`) -- `withErrorHandling`, `jsonResponse`, `bigIntReplacer`, `sanitizeForLogging`
- **Wallet providers** (`wallet/`) -- `MnemonicWalletProvider` (BIP-39), `signArbitraryWithAmino` (ADR-036)
- **Logger** (`logger.ts`) -- Leveled logger (stderr output; defaults to `warn`, configurable via `logger.setLevel()`; the node package's bootstrap reads `LOG_LEVEL` and applies it)
- **Retry** (`retry.ts`) -- Exponential backoff with transient/permanent error classification
- **Validation** (`validation.ts`) -- Input validation helpers (`requireString`, `requireUuid`, `parseArgs`, etc.)

## Supported modules

| Module | Query | Transaction |
|--------|:-----:|:-----------:|
| bank | yes | yes |
| staking | yes | yes |
| distribution | yes | yes |
| gov | yes | yes |
| billing | yes | yes |
| sku | yes | yes |
| group | yes | yes |
| wasm | yes | yes |
| poa | yes | yes |
| tokenfactory | yes | yes |
| ibc-transfer | yes | yes |
| auth | yes | -- |
| manifest | -- | yes |

## Usage

```typescript
import {
  CosmosClientManager,
  cosmosQuery,
  cosmosTx,
  createValidatedConfig,
} from '@manifest-network/manifest-mcp-core';

const config = createValidatedConfig({
  chainId: 'manifest-1',
  rpcUrl: 'https://your-rpc-endpoint/',
  gasPrice: '0.01umfx',
  addressPrefix: 'manifest',
});
```

## Build

```bash
npm run build    # tsdown (platform: neutral)
npm run lint     # tsc --noEmit
npm run test     # vitest
```

## License

MIT
