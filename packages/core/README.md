# @manifest-network/manifest-mcp-core

Shared library for Manifest MCP servers. Contains Cosmos SDK logic, on-chain tool functions, server utilities, and the LCD/REST adapter. This package is **not** an MCP server itself -- it provides building blocks that the chain, lease, fred, cosmwasm, and agent packages compose into servers.

## Installation

```bash
npm install @manifest-network/manifest-mcp-core
```

## What's inside

- **CosmosClientManager** (`client.ts`) -- Keyed-instance client lifecycle with rate limiting and lazy init (RPC + LCD)
- **LCD adapter** (`lcd-adapter.ts`) -- Converts LCD/REST responses to the RPC query client shape, making the codebase transport-agnostic
- **Module registry** (`modules.ts`) -- Static maps of Cosmos SDK modules with metadata and handler functions
- **Query/transaction routing** (`cosmos.ts`) -- Routes `(module, subcommand, args)` to per-module handlers
- **On-chain tool functions** (`tools/`) -- e.g. `getBalance`, `fundCredits`, `setItemCustomDomain`, `stopApp`, `executeTx` (atomic multi-message tx), plus read helpers such as `getLease` / `getSKUs` (used by lease and fred packages)
- **Server utilities** (`server-utils.ts`) -- `withErrorHandling`, `jsonResponse`, `structuredResponse`, `bigIntReplacer`, `sanitizeForLogging`
- **Tool annotation helpers** (`tool-metadata.ts`) -- `readOnlyAnnotations`, `mutatingAnnotations`, `manifestMeta` (versioned `_meta.manifest` payload, `MANIFEST_TOOL_META_VERSION = 1`)
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
| authz | yes | yes |
| feegrant | yes | yes |
| auth | yes | -- |
| mint | yes | -- |
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

## SSRF-guarded fetch

Core hosts a shared, SSRF-guarded `fetch` factory (used by the fred and agent-core packages to route provider / off-chain HTTP). It is **Node-only** and exposed via the dedicated subpath export `@manifest-network/manifest-mcp-core/guarded-fetch` -- **not** the package barrel (`index.ts`). Keeping it off the barrel keeps the barrel isomorphic: the guard dynamic-imports `undici` (which transitively pulls in `node:async_hooks`), so re-exporting it from the root would drag Node-only modules into browser / Deno bundle graphs.

```typescript
import {
  createGuardedFetch,
  isBlocked,
} from '@manifest-network/manifest-mcp-core/guarded-fetch';

const guardedFetch = createGuardedFetch();
```

- **`createGuardedFetch()`** returns a `typeof fetch` that DNS-resolves each connection target at connect time and rejects any address whose `ipaddr.js` range is not `'unicast'`.
- **Default-deny, allow-only-`'unicast'` policy.** Loopback, private, link-local (incl. cloud metadata at `169.254.169.254`), multicast, reserved, carrier-grade-NAT, and every other non-`unicast` classification are blocked; unparseable / unresolvable hosts fail closed.
- **`isBlocked(ip)`** exposes the same single-IP verdict for audit / test use -- returns `{ range, rfc }` when blocked, `null` when allowed.
- **Browser / Deno:** `createGuardedFetch()` throws by construction on non-Node runtimes. Pass your own `opts.fetch` to the consuming code path instead.

## Build

```bash
npm run build    # tsdown (platform: neutral)
npm run lint     # tsc --noEmit
npm run test     # vitest
```

## License

MIT
