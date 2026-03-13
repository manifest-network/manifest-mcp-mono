# Architecture

This document describes the architecture of the Manifest MCP monorepo -- MCP servers that bridge AI assistants to Cosmos SDK blockchains, with first-class support for the Manifest Network.

## Overview

The servers implement the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP), exposing blockchain queries, transactions, and Manifest-specific deployment tools to any MCP-compatible client (Claude Desktop, Cursor, etc.).

The 19 tools are split across three MCP servers to stay under the LLM tool-selection accuracy ceiling:

- **Chain server** (5 tools) -- Generic Cosmos SDK operations: queries, transactions, module discovery
- **Lease server** (6 tools) -- On-chain lease operations: credit balance, funding, lease queries, SKUs, providers
- **Fred server** (8 tools) -- Provider/Fred-dependent operations: catalog browsing, app deployment, status, logs, restart, update, diagnostics, releases

```
┌─────────────────────┐
│   MCP Client        │  Claude Desktop, Cursor, etc.
│   (AI Assistant)    │
└──┬──────┬──────┬────┘
   │stdio │stdio │stdio
┌──▼───┐┌─▼──┐┌─▼───┐
│chain ││lease││fred │  Transport + wallet resolution
│(node)││(node)││(node)│
└──┬───┘└──┬──┘└──┬──┘
   │       │      │
┌──▼───┐┌──▼──┐┌──▼──┐
│chain ││lease││fred │  MCP server, tool registration
│(pkg) ││(pkg) ││(pkg) │
└──┬───┘└──┬──┘└──┬──┘
   │       │      │
   └───────┼──────┘
     ┌─────▼─────┐
     │   core    │  Shared: Cosmos logic, on-chain tool functions
     │  (pkg)    │
     └─────┬─────┘
           │ RPC
      ┌────▼────┐  ┌─────────┐
      │  Chain  │  │ Provider│  Manifest ledger + cloud providers
      │  (RPC)  │  │  (HTTP) │  (fred calls providers directly)
      └─────────┘  └─────────┘
```

## Monorepo structure

```
packages/
  core/    @manifest-network/manifest-mcp-core    Shared library (Cosmos logic, on-chain tool functions)
  chain/   @manifest-network/manifest-mcp-chain   MCP server: 5 chain tools
  lease/   @manifest-network/manifest-mcp-lease   MCP server: 6 on-chain lease tools
  fred/    @manifest-network/manifest-mcp-fred    MCP server: 8 provider/Fred tools
  node/    @manifest-network/manifest-mcp-node    Three CLIs: manifest-mcp-chain, manifest-mcp-lease, manifest-mcp-fred
e2e/                                               End-to-end tests against a live chain
submodules/
  manifest-ledger/                                 Cosmos SDK blockchain (billing-v2 branch)
  fred/                                            Container orchestration backend (main branch)
```

Dependency direction: **node -> {chain, lease, fred, core}** and **{chain, lease, fred} -> core** (never reverse). Fred also uses its own HTTP clients internally. Core has no knowledge of transports or Node.js-specific APIs, though it exports MCP-typed server utilities (`withErrorHandling`, `jsonResponse`) consumed by chain, lease, and fred packages.

## Package: core

The core package is a shared library containing Cosmos logic, on-chain tool functions, and server utilities. It is **not** an MCP server itself -- it exports building blocks that chain, lease, and fred packages compose into servers. HTTP clients for provider/Fred APIs are **not** in core; they live in the fred package.

### Source layout

```
src/
├── index.ts              Re-exports all public API
├── server-utils.ts       Server utilities (error handling, sanitization, response helpers)
├── __test-utils__/
│   └── mocks.ts          Shared test mocks (imported cross-package by chain/lease/fred tests)
├── client.ts             CosmosClientManager -- keyed-instance RPC client lifecycle
├── config.ts             Configuration validation and defaults
├── cosmos.ts             cosmosQuery / cosmosTx routing to module handlers
├── modules.ts            Module registry with metadata and discovery
├── types.ts              Shared type definitions
├── validation.ts         Input validation helpers
├── retry.ts              Retry with exponential backoff
├── version.ts            Package version constant
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
└── tools/                On-chain tool functions (used by lease package)
    ├── getBalance.ts     On-chain + credit balance
    ├── fundCredits.ts    Send tokens to billing account
    └── stopApp.ts        Close lease on-chain
```

### Key components

**CosmosClientManager** (`client.ts`) -- Keyed-instance cache that manages RPC client lifecycle (one instance per `chainId:rpcUrl` pair). Key features:
- Lazy initialization with promise-based concurrency control (multiple callers wait for the same init)
- Token-bucket rate limiting (default: 10 requests/sec via `limiter`), acquired by callers before RPC calls
- Automatic retry with exponential backoff (base 1s, max 10s, 3 retries)

**Module registry** (`modules.ts`) -- Static `QUERY_MODULES` and `TX_MODULES` maps that register each Cosmos module's metadata (description, subcommands) and handler functions. This powers the `list_modules` and `list_module_subcommands` discovery tools, allowing AI clients to explore available operations dynamically.

**cosmosQuery / cosmosTx** (`cosmos.ts`) -- Routes a `(module, subcommand, args)` tuple to the correct query or transaction handler by looking up the module registry.

**Server utilities** (`server-utils.ts`) -- Shared by chain, lease, and fred packages: `withErrorHandling` (wraps tool handlers with error sanitization), `jsonResponse` (formats successful responses), `bigIntReplacer` (serializes BigInt), `sanitizeForLogging` (redacts sensitive fields).

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

## Package: lease

The lease package is an MCP server that registers 6 on-chain lease tools:

| Tool | Purpose |
|------|---------|
| `credit_balance` | Query on-chain credit balance |
| `fund_credit` | Send tokens to billing account |
| `leases_by_tenant` | Query leases by tenant and state |
| `close_lease` | Close a lease on-chain |
| `get_skus` | List available SKUs |
| `get_providers` | List available providers |

The lease server performs purely on-chain operations using core's tool functions and Cosmos query/transaction routing. It does not call any off-chain HTTP APIs.

## Package: fred

The fred package is an MCP server that registers 8 provider/Fred-dependent tools:

| Tool | Purpose |
|------|---------|
| `browse_catalog` | List providers + SKU pricing with health checks |
| `deploy_app` | Create lease + deploy container |
| `app_status` | Lease status + provider info |
| `get_logs` | Fetch container logs |
| `restart_app` | Restart via provider API |
| `update_app` | Update container manifest |
| `app_diagnostics` | Detailed lease diagnostics (provision status, connection info) |
| `app_releases` | List deployment release history |

The fred server handles ADR-036 provider authentication internally and contains the HTTP clients for provider and Fred APIs.

### Source layout

```
src/
├── index.ts              FredMCPServer (8 tools)
├── manifest.ts           Manifest building, merging, and validation
├── http/
│   ├── auth.ts           ADR-036 signature-based authentication
│   ├── provider.ts       Provider API client (URL validation, health, lease info & uploads)
│   └── fred.ts           Fred API client (lease status, logs, restart, update, releases)
└── tools/
    ├── fetchActiveLease.ts      Shared helper: resolve active lease
    ├── resolveLeaseProvider.ts  Provider URL lookup
    ├── browseCatalog.ts         List providers + SKU pricing with health checks
    ├── deployApp.ts             Create lease + deploy container
    ├── appStatus.ts             Lease status + provider info
    ├── getLogs.ts               Fetch container logs
    ├── restartApp.ts            Restart via provider API
    └── updateApp.ts             Update container manifest
```

## Package: node

The node package provides three Node.js CLI entry points:

- **`manifest-mcp-chain`** (`chain.ts`) -- Spawns `ChainMCPServer` with stdio transport
- **`manifest-mcp-lease`** (`lease.ts`) -- Spawns `LeaseMCPServer` with stdio transport
- **`manifest-mcp-fred`** (`fred.ts`) -- Spawns `FredMCPServer` with stdio transport

All three entry points share the same wallet resolution and subcommand handling:

1. **Wallet resolution** -- Checks for an encrypted keyfile first (`KeyfileWalletProvider`), falls back to a BIP-39 mnemonic env var (`MnemonicWalletProvider`)
2. **Transport binding** -- Connects the server to a `StdioServerTransport`
3. **CLI subcommands** -- `keygen` and `import` for wallet management (interactive, password-protected)

```
src/
├── bootstrap.ts          Shared CLI bootstrap (wallet resolution, transport, error handling)
├── chain.ts              Chain CLI entry point
├── lease.ts              Lease CLI entry point
├── fred.ts               Fred CLI entry point
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

The optional `signArbitrary` method enables ADR-036 authentication for provider HTTP APIs (used by fred). Both `MnemonicWalletProvider` (core) and `KeyfileWalletProvider` (node) implement it.

## Request flow

A typical tool call follows this path:

```
MCP Client
  -> JSON-RPC over stdio
    -> StdioServerTransport (node)
      -> Server.handleRequest (MCP SDK)
        -> Tool handler (chain, lease, or fred server)
          -> Core function (e.g., cosmosQuery -> cosmos.ts -> queries/bank.ts)
            -> CosmosClientManager.getQueryClient()
              -> RPC call to chain
            <- Response
          <- Formatted result
        <- MCP tool response
      <- JSON-RPC response
    <- stdio
  <- Displayed to user
```

For fred tools, the flow additionally involves:
1. Querying on-chain state (lease, billing, SKU data) via RPC
2. Authenticating with providers using ADR-036 signed messages (via `http/auth.ts` in fred)
3. Calling provider HTTP APIs (via `http/provider.ts` and `http/fred.ts` in the fred package)

## Authentication

Provider APIs require authentication via ADR-036 arbitrary message signing:

1. The wallet signs a deterministic message containing the account address, lease UUID, and ISO timestamp
2. The signature, public key, and metadata are assembled into a JSON payload and base64-encoded client-side via `createAuthToken()`
3. The base64 token is included as a `Bearer` token in HTTP Authorization headers

There is no round-trip to an auth endpoint -- the token is constructed entirely client-side. Token expiry is enforced server-side by the provider.

This is handled by `http/auth.ts` in the fred package and used by fred server tools that interact with providers (deploy, status, logs, restart, update).

## Error handling

Errors use the `ManifestMCPErrorCode` enum (15 codes across 6 categories):

| Category | Codes |
|----------|-------|
| Configuration | `INVALID_CONFIG`, `MISSING_CONFIG` |
| Wallet | `WALLET_NOT_CONNECTED`, `WALLET_CONNECTION_FAILED`, `INVALID_MNEMONIC` |
| Client/RPC | `CLIENT_NOT_INITIALIZED`, `RPC_CONNECTION_FAILED` |
| Query | `QUERY_FAILED`, `UNSUPPORTED_QUERY`, `INVALID_ADDRESS` |
| Transaction | `TX_FAILED`, `TX_BROADCAST_FAILED`, `UNSUPPORTED_TX`, `INSUFFICIENT_FUNDS` |
| Module | `UNKNOWN_MODULE` |

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
