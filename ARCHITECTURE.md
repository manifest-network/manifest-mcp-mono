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
           │ RPC or LCD/REST
      ┌────▼────┐  ┌────▼────┐  ┌─────────┐
      │  Chain  │  │  Chain  │  │ Provider│  Manifest ledger + cloud providers
      │  (RPC)  │  │ (LCD)   │  │  (HTTP) │  (fred calls providers directly)
      └─────────┘  └─────────┘  └─────────┘
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
├── logger.ts             Leveled logger (stderr output, configurable via LOG_LEVEL env var)
├── server-utils.ts       Server utilities (error handling, sanitization, response helpers)
├── __test-utils__/
│   ├── callTool.ts       MCP tool invocation helper for unit tests (in-memory transport)
│   └── mocks.ts          Shared test mocks (imported cross-package by chain/lease/fred tests)
├── client.ts             CosmosClientManager -- keyed-instance client lifecycle (RPC + LCD)
├── lcd-adapter.ts        LCD/REST adapter -- converts LCD responses to RPC query client shape
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
│   ├── mnemonic.ts       MnemonicWalletProvider (BIP-39)
│   └── sign-arbitrary.ts ADR-036 signArbitrary with amino wallet
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

**CosmosClientManager** (`client.ts`) -- Keyed-instance cache that manages client lifecycle (one instance per `chainId:rpcUrl[:restUrl]` tuple). Supports two operating modes:
- **Full mode** (`rpcUrl` + `gasPrice`): queries via RPC or LCD, transactions via signing client
- **Query-only mode** (`restUrl` only): queries via LCD/REST, `getSigningClient()` throws `INVALID_CONFIG`
- When both `rpcUrl` and `restUrl` are configured, `restUrl` is preferred for queries

Key features:
- Lazy initialization with promise-based concurrency control (multiple callers wait for the same init)
- Token-bucket rate limiting (default: 10 requests/sec via `limiter`), acquired by callers before chain calls
- Automatic retry with exponential backoff (base 1s, max 10s, 3 retries)
- Selective invalidation on config update: signing client is recreated only when `gasPrice` or `walletProvider` changes; query client is never invalidated (stateless HTTP)

**Module registry** (`modules.ts`) -- Static `QUERY_MODULES` and `TX_MODULES` maps that register each Cosmos module's metadata (description, subcommands) and handler functions. This powers the `list_modules` and `list_module_subcommands` discovery tools, allowing AI clients to explore available operations dynamically.

**cosmosQuery / cosmosTx** (`cosmos.ts`) -- Routes a `(module, subcommand, args)` tuple to the correct query or transaction handler by looking up the module registry.

**LCD adapter** (`lcd-adapter.ts`) -- Adapts the LCD/REST client from manifestjs to match the `ManifestQueryClient` shape used by RPC, making the rest of the codebase transport-agnostic. For each LCD module method, the adapter: (1) calls the original LCD method, (2) converts the snake_case JSON response to camelCase via `snakeToCamelDeep()`, (3) runs the result through the matching protobuf `fromJSON` converter. Modules without LCD support (`cosmos.orm.query.v1alpha1`, `liftedinit.manifest.v1`) return proxy objects that throw `UNSUPPORTED_QUERY` on access.

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
| `app_diagnostics` | Provision diagnostics (status, failure count, last error) |
| `app_releases` | List deployment release history |

The fred server handles ADR-036 provider authentication internally and contains the HTTP clients for provider and Fred APIs. The package also exports all tool functions and HTTP clients for use by library consumers (e.g., Barney) without requiring the MCP protocol.

### Source layout

```
src/
├── index.ts              FredMCPServer (8 tools; app_diagnostics and app_releases are inline here)
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

### HTTP clients

The fred package contains three HTTP client modules that are not in core (to keep core browser-compatible without HTTP client dependencies):

- **`http/auth.ts`** -- ADR-036 token construction. No network calls; pure functions that build sign messages and assemble base64 bearer tokens.
- **`http/provider.ts`** -- Provider API client: `checkedFetch()` (fetch wrapper with timeout and error normalization), `uploadLeaseData()`, `getLeaseConnectionInfo()`, `getProviderHealth()`. All provider URLs are validated to require HTTPS (localhost HTTP allowed for development).
- **`http/fred.ts`** -- Fred API client: `getLeaseStatus()`, `getLeaseLogs()`, `getLeaseProvision()`, `restartLease()`, `updateLease()`, `getLeaseReleases()`, and `pollLeaseUntilReady()` (polls status at 3-second intervals with 120-second timeout, AbortSignal support, and progress callbacks).

### Deployment flow (`deploy_app`)

The most complex operation, orchestrating on-chain and off-chain steps:

```
1. Build manifest        buildManifest({ image, ports }) or buildStackManifest({ services })
2. Hash manifest         SHA-256 of JSON string -> metaHashHex
3. Find SKU              Query chain for SKU UUID and provider UUID matching requested size (e.g., "docker-micro")
4. Resolve provider      Query chain for provider API URL from SKU's provider UUID
5. Create lease (tx)     cosmosTx('billing', 'create-lease', ['--meta-hash', metaHashHex, ...leaseItems])
6. Extract lease UUID    Parse from transaction events
7. Upload manifest       POST manifest bytes to provider with ADR-036 auth + meta_hash
8. Poll until ready      GET lease status until ACTIVE (or terminal state / timeout)
9. Get connection info   GET connection details (host, ports) -- best-effort, non-fatal
```

If steps 7-8 fail after the on-chain lease is created, the error includes `lease_uuid`, `provider_uuid`, and `provider_url` so the caller can close the orphaned lease.

### Manifest format

Stack manifests use the `{ services: { ... } }` wrapper format. The `buildManifest()` function constructs single-service manifests while `buildStackManifest()` constructs multi-service stacks. Upload payloads are `Uint8Array`.

## Package: node

The node package provides three Node.js CLI entry points:

- **`manifest-mcp-chain`** (`chain.ts`) -- Spawns `ChainMCPServer` with stdio transport
- **`manifest-mcp-lease`** (`lease.ts`) -- Spawns `LeaseMCPServer` with stdio transport
- **`manifest-mcp-fred`** (`fred.ts`) -- Spawns `FredMCPServer` with stdio transport

All three entry points share the same wallet resolution and subcommand handling:

1. **Wallet resolution** -- Checks for a keyfile first (`KeyfileWalletProvider`, supports both encrypted and plaintext formats), falls back to a BIP-39 mnemonic env var (`MnemonicWalletProvider`)
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

The optional `signArbitrary` method enables ADR-036 authentication for provider HTTP APIs (used by fred). Both `MnemonicWalletProvider` (core) and `KeyfileWalletProvider` (node) implement it using dual wallets: a `DirectSecp256k1HdWallet` for proto-signing (transactions) and a `Secp256k1HdWallet` for amino-signing (ADR-036 auth tokens). Both providers use promise deduplication to prevent redundant initialization from concurrent calls.

## Request flow

A typical tool call follows this path:

```
MCP Client
  -> JSON-RPC over stdio
    -> StdioServerTransport (node)
      -> Server.handleRequest (MCP SDK)
        -> Tool handler (chain, lease, or fred server)
          -> Core function (e.g., cosmosQuery -> cosmos.ts -> queries/bank.ts)
            -> acquireRateLimit()
            -> CosmosClientManager.getQueryClient()
              -> LCD/REST call (if restUrl configured)
              -> or RPC call (if rpcUrl only)
            <- Response
          <- Formatted result
        <- MCP tool response
      <- JSON-RPC response
    <- stdio
  <- Displayed to user
```

For fred tools, the flow additionally involves:
1. Querying on-chain state (lease, billing, SKU data) via RPC or LCD/REST
2. Authenticating with providers using ADR-036 signed messages (via `http/auth.ts` in fred)
3. Calling provider HTTP APIs (via `http/provider.ts` and `http/fred.ts` in the fred package)

## Authentication

Provider APIs require authentication via ADR-036 arbitrary message signing:

1. The wallet signs a deterministic message containing the account address, lease UUID, and unix epoch timestamp (e.g., `"tenant:leaseUuid:1711234567"`)
2. The signature, public key, and metadata are assembled into a JSON payload (`tenant`, `lease_uuid`, `timestamp`, `pub_key`, `signature`, and optionally `meta_hash` for data uploads) and base64-encoded client-side via `createAuthToken()`
3. The base64 token is included as a `Bearer` token in HTTP Authorization headers

There is no round-trip to an auth endpoint -- the token is constructed entirely client-side. Token expiry is enforced server-side by the provider.

For lease data uploads (e.g., manifest upload during deployment), a variant sign message format includes the SHA-256 hash of the payload: `"manifest lease data <uuid> <metaHashHex> <timestamp>"`.

This is handled by `http/auth.ts` in the fred package and used by all fred server tools that interact with providers (deploy, status, logs, restart, update, diagnostics, releases).

## Error handling

Errors use the `ManifestMCPErrorCode` enum (14 codes across 6 categories):

| Category | Codes |
|----------|-------|
| Configuration | `INVALID_CONFIG`, `MISSING_CONFIG` |
| Wallet | `WALLET_NOT_CONNECTED`, `WALLET_CONNECTION_FAILED`, `INVALID_MNEMONIC` |
| Client/RPC | `RPC_CONNECTION_FAILED` |
| Query | `QUERY_FAILED`, `UNSUPPORTED_QUERY`, `INVALID_ADDRESS` |
| Transaction | `TX_FAILED`, `TX_BROADCAST_FAILED`, `UNSUPPORTED_TX`, `INSUFFICIENT_FUNDS` |
| Module | `UNKNOWN_MODULE` |

Error responses returned to MCP clients sanitize structured fields (such as `input` and `details`) via a redaction helper so that sensitive values (mnemonics, passwords, keys, tokens) are not exposed; the top-level `error.message` string is passed through verbatim and should not contain secrets.

## Configuration

Configuration is validated at startup via `createValidatedConfig`:

- **Chain ID**: alphanumeric with hyphens
- **RPC URL**: HTTPS required (HTTP allowed only for localhost). At least one of `rpcUrl` or `restUrl` required.
- **REST URL**: HTTPS required (HTTP allowed only for localhost). Enables query-only LCD/REST mode.
- **Gas price**: numeric + denom format (e.g., `0.01umfx`). Required when `rpcUrl` is set.
- **Address prefix**: lowercase letters (default: `manifest`)
- **Rate limiting**: requests per second (must be positive integer, default: 10)
- **Retry**: max retries, base delay, max delay (with cross-field validation: max delay >= base delay)

## Logging

All MCP server output goes to **stderr** because stdout is reserved for the MCP JSON-RPC protocol. The leveled logger (`core/src/logger.ts`) reads `process.env.LOG_LEVEL` at import time and supports `debug`, `info`, `warn`, `error`, and `silent` (default: `warn`). The level can also be changed at runtime via `logger.setLevel()`.

`LOG_LEVEL` is a core-level concern -- it is read directly from the environment by the logger module, not loaded by the node package's config system. It takes effect in any process that imports core.

## E2E testing

End-to-end tests live in `/e2e/` and run against a real Manifest chain via Docker Compose:

```
e2e/
├── docker-compose.yml          Spins up manifestd + providerd with TLS
├── chain-tools.e2e.test.ts     Chain server tool tests (queries, transactions, modules)
├── lifecycle.e2e.test.ts       Full lease lifecycle (deploy, status, logs, restart, update, close)
├── vitest.config.ts            Vitest config with 5-minute timeout
├── docker/                     Dockerfiles for chain and provider containers
├── scripts/                    Init scripts (chain genesis, billing setup)
└── helpers/
    ├── global-setup.ts         Docker health checks and wallet funding
    └── mcp-client.ts           Spawns MCP server processes and provides a callTool helper
```

To run:

```bash
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
```

## Build and test

- **Build**: `tsdown` (unbundled ESM output with sourcemaps and `.d.ts` declarations). Core, chain, lease, and fred use `platform: "neutral"` for browser compatibility; node uses `platform: "node"`.
- **Unit tests**: Vitest, co-located `*.test.ts` files
- **E2E tests**: See [E2E testing](#e2e-testing) above
- **Type checking**: `tsc --noEmit`

## Dependencies

Key external dependencies:

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol implementation |
| `@cosmjs/*` | Cosmos SDK client libraries (signing, encoding, stargate) |
| `@manifest-network/manifestjs` | Manifest-specific protobuf types, codegen, and LCD client |
| `@manifest-network/stargate` | Custom fork of `@cosmjs/stargate` (applied via npm overrides) |
| `limiter` | Token-bucket rate limiting |
| `zod` | Input schema validation for MCP tool parameters (chain, lease, fred) |
