# Architecture

This document describes the architecture of the Manifest MCP monorepo — MCP servers that bridge AI assistants to Cosmos SDK blockchains, with first-class support for the Manifest Network.

## Overview

The servers implement the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP), exposing blockchain queries, transactions, and Manifest-specific deployment tools to any MCP-compatible client (Claude Desktop, Cursor, etc.).

The 15 tools are split across two MCP servers to stay under the LLM tool-selection accuracy ceiling:

- **Chain server** (5 tools) — Generic Cosmos SDK operations: queries, transactions, module discovery
- **Cloud server** (10 tools) — Manifest cloud deployment: app lifecycle, billing, provider management

```
┌─────────────────────┐
│   MCP Client        │  Claude Desktop, Cursor, etc.
│   (AI Assistant)    │
└───┬────────────┬────┘
    │ stdio      │ stdio
┌───▼──────┐ ┌───▼──────┐
│  chain   │ │  cloud   │  Transport + wallet resolution
│ (node)   │ │ (node)   │
└───┬──────┘ └───┬──────┘
    │            │
┌───▼──────┐ ┌───▼──────┐
│  chain   │ │  cloud   │  MCP server, tool registration
│ (pkg)    │ │ (pkg)    │
└───┬──────┘ └───┬──────┘
    │            │
    └──────┬─────┘
    ┌──────▼─────┐
    │    core    │  Shared: Cosmos logic, tool impls, HTTP clients
    │  (pkg)     │
    └──────┬─────┘
           │ RPC / HTTP
      ┌────▼────┐  ┌─────────┐
      │  Chain  │  │ Provider│  Manifest ledger + cloud providers
      │  (RPC)  │  │  (HTTP) │
      └─────────┘  └─────────┘
```

## Monorepo structure

```
packages/
  core/    @manifest-network/manifest-mcp-core    Shared library (Cosmos logic, tool functions, HTTP clients)
  chain/   @manifest-network/manifest-mcp-chain   MCP server: 5 chain tools
  cloud/   @manifest-network/manifest-mcp-cloud   MCP server: 10 deployment tools
  node/    @manifest-network/manifest-mcp-node     Two CLIs: manifest-mcp-chain, manifest-mcp-cloud
e2e/                                               End-to-end tests against a live chain
submodules/
  manifest-ledger/                                 Cosmos SDK blockchain (billing-v2 branch)
  fred/                                            Container orchestration backend (main branch)
```

Dependency direction: **node → {chain, cloud, core}** and **{chain, cloud} → core** (never reverse). Core has no knowledge of transports or Node.js-specific APIs, though it exports MCP-typed server utilities (`withErrorHandling`, `jsonResponse`) consumed by chain and cloud packages.

## Package: core

The core package is a shared library containing all blockchain logic, tool implementation functions, HTTP clients, and server utilities. It is **not** an MCP server itself — it exports building blocks that chain and cloud packages compose into servers.

### Source layout

```
src/
├── index.ts              Re-exports all public API
├── server-utils.ts       Server utilities (error handling, sanitization, response helpers)
├── __test-utils__/
│   └── mocks.ts          Shared test mocks (imported cross-package by chain/cloud tests)
├── client.ts             CosmosClientManager — keyed-instance RPC client lifecycle
├── config.ts             Configuration validation and defaults
├── cosmos.ts             cosmosQuery / cosmosTx routing to module handlers
├── modules.ts            Module registry with metadata and discovery
├── types.ts              Shared type definitions
├── validation.ts         Input validation helpers
├── retry.ts              Retry with exponential backoff
├── version.ts            Package version constant
│
├── http/                 HTTP clients for off-chain services
│   ├── auth.ts           ADR-036 signature-based authentication
│   ├── provider.ts       Provider API client (URL validation, health, lease info & uploads)
│   └── fred.ts           Fred API client (lease status, logs, restart, update)
│
├── wallet/               Wallet provider implementations
│   ├── index.ts          Barrel re-exports
│   └── mnemonic.ts       MnemonicWalletProvider (BIP-39)
│
├── queries/              Cosmos SDK query handlers (one file per module)
│   ├── bank.ts           Balance, supply, denom metadata
│   ├── staking.ts        Validators, delegations
│   ├── distribution.ts   Rewards, commission
│   ├── gov.ts            Proposals, votes, deposits
│   ├── auth.ts           Account info
│   ├── billing.ts        Leases, credit accounts (Manifest-specific)
│   ├── sku.ts            Providers, SKUs (Manifest-specific)
│   ├── group.ts          Group governance
│   └── utils.ts          Pagination helpers
│
├── transactions/         Cosmos SDK transaction handlers (one file per module)
│   ├── bank.ts           Send
│   ├── staking.ts        Delegate, undelegate, redelegate
│   ├── distribution.ts   Withdraw rewards/commission
│   ├── gov.ts            Submit proposal, vote, deposit
│   ├── billing.ts        Lease operations, credit management
│   ├── manifest.ts       Manifest-specific transactions
│   ├── sku.ts            SKU management
│   ├── group.ts          Group governance transactions
│   └── utils.ts          Signature and broadcast helpers
│
└── tools/                High-level Manifest deployment tool functions
    ├── browseCatalog.ts  List providers and SKU pricing
    ├── getBalance.ts     On-chain + credit balance
    ├── fundCredits.ts    Send tokens to billing account
    ├── listApps.ts       Query leases by state
    ├── appStatus.ts      Lease status + provider info
    ├── getLogs.ts        Fetch container logs
    ├── deployApp.ts      Create lease and deploy container
    ├── stopApp.ts        Close lease on-chain
    ├── restartApp.ts     Restart via provider API
    ├── updateApp.ts      Update container manifest
    └── resolveLeaseProvider.ts  Provider info lookup
```

### Key components

**CosmosClientManager** (`client.ts`) — Keyed-instance cache that manages RPC client lifecycle (one instance per `chainId:rpcUrl` pair). Key features:
- Lazy initialization with promise-based concurrency control (multiple callers wait for the same init)
- Token-bucket rate limiting (default: 10 requests/sec via `limiter`), acquired by callers before RPC calls
- Automatic retry with exponential backoff (base 1s, max 10s, 3 retries)

**Module registry** (`modules.ts`) — Static `QUERY_MODULES` and `TX_MODULES` maps that register each Cosmos module's metadata (description, subcommands) and handler functions. This powers the `list_modules` and `list_module_subcommands` discovery tools, allowing AI clients to explore available operations dynamically.

**cosmosQuery / cosmosTx** (`cosmos.ts`) — Routes a `(module, subcommand, args)` tuple to the correct query or transaction handler by looking up the module registry.

**Server utilities** (`server-utils.ts`) — Shared by chain and cloud packages: `withErrorHandling` (wraps tool handlers with error sanitization), `jsonResponse` (formats successful responses), `bigIntReplacer` (serializes BigInt), `sanitizeForLogging` (redacts sensitive fields).

## Package: chain

The chain package is an MCP server that registers 5 generic Cosmos SDK tools:

| Tool | Purpose |
|------|---------|
| `get_account_info` | Get the active wallet address |
| `cosmos_query` | Execute any Cosmos SDK query |
| `cosmos_tx` | Execute any Cosmos SDK transaction |
| `list_modules` | Discover available query/tx modules |
| `list_module_subcommands` | Discover subcommands for a module |

The `ChainMCPServer` class takes a `ManifestMCPServerOptions` (config + walletProvider), creates an `McpServer`, and registers the 5 tools using core's `cosmosQuery`, `cosmosTx`, and module registry functions.

## Package: cloud

The cloud package is an MCP server that registers 10 Manifest deployment tools:

| Tool | Purpose |
|------|---------|
| `browse_catalog` | List providers and SKU pricing |
| `get_balance` | On-chain + credit balance |
| `fund_credits` | Send tokens to billing account |
| `list_apps` | Query leases by state |
| `app_status` | Lease status + provider info |
| `get_logs` | Fetch container logs |
| `deploy_app` | Create lease and deploy container |
| `stop_app` | Close lease on-chain |
| `restart_app` | Restart via provider API |
| `update_app` | Update container manifest |

The `CloudMCPServer` class handles ADR-036 provider authentication internally (via `getProviderAuthToken` and `getLeaseDataAuthToken` private methods) and delegates to core's tool functions.

## Package: node

The node package provides two Node.js CLI entry points:

- **`manifest-mcp-chain`** (`chain.ts`) — Spawns `ChainMCPServer` with stdio transport
- **`manifest-mcp-cloud`** (`cloud.ts`) — Spawns `CloudMCPServer` with stdio transport

Both entry points share the same wallet resolution and subcommand handling:

1. **Wallet resolution** — Checks for an encrypted keyfile first (`KeyfileWalletProvider`), falls back to a BIP-39 mnemonic env var (`MnemonicWalletProvider`)
2. **Transport binding** — Connects the server to a `StdioServerTransport`
3. **CLI subcommands** — `keygen` and `import` for wallet management (interactive, password-protected)

```
src/
├── bootstrap.ts          Shared CLI bootstrap (wallet resolution, transport, error handling)
├── chain.ts              Chain CLI entry point
├── cloud.ts              Cloud CLI entry point
├── config.ts             Environment variable loading
├── keyfileWallet.ts      Encrypted keyfile wallet provider
└── keygen.ts             Interactive key generation and import
```

### Wallet provider interface

All packages share the `WalletProvider` interface from core:

```typescript
interface WalletProvider {
  getAddress(): Promise<string>;
  getSigner(): Promise<OfflineSigner>;
  signArbitrary?(address: string, data: string): Promise<SignArbitraryResult>;
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}
```

The optional `signArbitrary` method enables ADR-036 authentication for provider HTTP APIs. Both `MnemonicWalletProvider` (core) and `KeyfileWalletProvider` (node) implement it.

## Request flow

A typical tool call follows this path:

```
MCP Client
  → JSON-RPC over stdio
    → StdioServerTransport (node)
      → Server.handleRequest (MCP SDK)
        → Tool handler (chain or cloud server)
          → Core function (e.g., cosmosQuery → cosmos.ts → queries/bank.ts)
            → CosmosClientManager.getQueryClient()
              → RPC call to chain
            ← Response
          ← Formatted result
        ← MCP tool response
      ← JSON-RPC response
    ← stdio
  ← Displayed to user
```

For Manifest deployment tools (cloud server), the flow additionally involves:
1. Querying on-chain state (lease, billing, SKU data) via RPC
2. Authenticating with providers using ADR-036 signed messages
3. Calling provider HTTP APIs (via `http/provider.ts` and `http/fred.ts`)

## Authentication

Provider APIs require authentication via ADR-036 arbitrary message signing:

1. The wallet signs a deterministic message containing the account address, lease UUID, and ISO timestamp
2. The signature, public key, and metadata are assembled into a JSON payload and base64-encoded client-side via `createAuthToken()`
3. The base64 token is included as a `Bearer` token in HTTP Authorization headers

There is no round-trip to an auth endpoint — the token is constructed entirely client-side. Tokens expire after 60 seconds.

This is handled by `http/auth.ts` and used by the cloud server tools that interact with providers (deploy, status, logs, restart, update).

## Error handling

Errors use the `ManifestMCPErrorCode` enum (20 codes across 7 categories):

| Category | Codes |
|----------|-------|
| Configuration | `INVALID_CONFIG`, `MISSING_CONFIG` |
| Wallet | `WALLET_NOT_CONNECTED`, `WALLET_CONNECTION_FAILED`, `KEPLR_NOT_INSTALLED`, `INVALID_MNEMONIC` |
| Client/RPC | `CLIENT_NOT_INITIALIZED`, `RPC_CONNECTION_FAILED` |
| Query | `QUERY_FAILED`, `UNSUPPORTED_QUERY`, `INVALID_ADDRESS` |
| Transaction | `TX_FAILED`, `TX_SIMULATION_FAILED`, `TX_BROADCAST_FAILED`, `TX_CONFIRMATION_TIMEOUT`, `UNSUPPORTED_TX`, `INSUFFICIENT_FUNDS` |
| Module | `UNKNOWN_MODULE`, `UNKNOWN_SUBCOMMAND` |
| General | `UNKNOWN_ERROR` |

Error responses returned to MCP clients sanitize structured fields (such as `input` and `details`) via a redaction helper so that sensitive values (mnemonics, passwords, keys, tokens) are not exposed; the top-level `error.message` string is passed through verbatim and should not contain secrets.

## Configuration

Configuration is validated at startup via `createValidatedConfig`:

- **Chain ID**: alphanumeric with hyphens
- **RPC URL**: HTTPS required (HTTP allowed only for localhost)
- **Gas price**: numeric + denom format (e.g., `0.01umfx`)
- **Address prefix**: lowercase letters (default: `manifest`)
- **Rate limiting**: requests per second (must be positive integer, default: 10)
- **Retry**: max retries, base delay, max delay (with cross-field validation: max delay >= base delay)

## Build and test

- **Build**: `tsdown` (unbundled ESM output with sourcemaps and `.d.ts` declarations)
- **Unit tests**: Vitest, co-located `*.test.ts` files
- **E2E tests**: `/e2e` directory, runs against a live chain with a 5-minute timeout
- **Type checking**: `tsc --noEmit`

## Dependencies

Key external dependencies:

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol implementation |
| `@cosmjs/*` | Cosmos SDK client libraries (signing, encoding, stargate) |
| `@manifest-network/manifestjs` | Manifest-specific protobuf types and codegen |
| `limiter` | Token-bucket rate limiting |
