# Architecture

This document describes the architecture of the Manifest MCP monorepo -- MCP servers that bridge AI assistants to Cosmos SDK blockchains, with first-class support for the Manifest Network.

For user-facing guidance (tool selection, end-to-end examples, prompts/resources, troubleshooting, security model, library usage), see the [`docs/`](docs/) directory.

## Overview

The servers implement the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP), exposing blockchain queries, transactions, and Manifest-specific deployment tools to any MCP-compatible client (Claude Desktop, Cursor, etc.).

The 27 tools (+ 1 optional faucet) are split across four MCP servers to stay under the LLM tool-selection accuracy ceiling:

- **Chain server** (6 tools, +1 optional `request_faucet`) -- Generic Cosmos SDK operations: queries, transactions, fee estimation, module discovery
- **Lease server** (8 tools) -- On-chain lease operations: credit balance, funding, lease queries, custom-domain claim/lookup, SKUs, providers
- **Fred server** (11 tools + 3 resources + 3 prompts) -- Provider/Fred-dependent operations: catalog browsing, deployment readiness checks, manifest preview, app deployment, ready polling, status, logs, restart, update, diagnostics, releases
- **CosmWasm server** (2 tools) -- MFX-to-PWR converter contract: rate queries, token conversion

```
┌──────────────────────────────────────┐
│            MCP Client                │  Claude Desktop, Cursor, etc.
│           (AI Assistant)             │
└──┬────────┬────────┬────────┬────────┘
   │ stdio  │ stdio  │ stdio  │ stdio
┌──▼─────┐┌─▼─────┐┌─▼─────┐┌─▼────────┐
│ chain  ││ lease ││ fred  ││ cosmwasm │  Transport + wallet resolution
│ (node) ││ (node) ││ (node) ││ (node)   │
└──┬─────┘└──┬────┘└──┬────┘└──┬───────┘
   │         │        │        │
┌──▼─────┐┌──▼─────┐┌─▼─────┐┌─▼────────┐
│ chain  ││ lease  ││ fred  ││ cosmwasm │  MCP server, tool registration
│ (pkg)  ││ (pkg)  ││ (pkg) ││ (pkg)    │
└──┬─────┘└──┬─────┘└──┬────┘└──┬───────┘
   │         │         │        │
   └─────────┼─────────┼────────┘
       ┌─────▼─────────┘
       │    core     │  Shared: Cosmos logic, on-chain tool functions
       │   (pkg)     │
       └─────┬───────┘
             │ RPC or LCD/REST
        ┌────▼────┐  ┌────▼────┐  ┌─────────┐
        │  Chain  │  │  Chain  │  │ Provider│  Manifest ledger + cloud providers
        │  (RPC)  │  │ (LCD)   │  │  (HTTP) │  (fred calls providers directly)
        └─────────┘  └─────────┘  └─────────┘
```

## Monorepo structure

```
packages/
  core/      @manifest-network/manifest-mcp-core      Shared library (Cosmos logic, on-chain tool functions)
  chain/     @manifest-network/manifest-mcp-chain     MCP server: 6 chain tools (+ optional request_faucet)
  lease/     @manifest-network/manifest-mcp-lease     MCP server: 8 on-chain lease tools
  fred/      @manifest-network/manifest-mcp-fred      MCP server: 11 provider/Fred tools, 3 resources, 3 prompts
  cosmwasm/  @manifest-network/manifest-mcp-cosmwasm  MCP server: 2 converter tools
  node/      @manifest-network/manifest-mcp-node      Four CLIs: manifest-mcp-chain, manifest-mcp-lease, manifest-mcp-fred, manifest-mcp-cosmwasm
e2e/                                                   End-to-end tests against a live chain
submodules/
  manifest-ledger/                                 Cosmos SDK blockchain (main branch, v2.1.0+)
  fred/                                            Container orchestration backend (main branch)
```

Dependency direction: **node -> {chain, lease, fred, cosmwasm} -> core** (never reverse; node also depends on core directly). Fred also uses its own HTTP clients internally. Core has no knowledge of transports or Node.js-specific APIs, though it exports MCP-typed server utilities (`withErrorHandling`, `jsonResponse`) consumed by chain, lease, fred, and cosmwasm packages.

## Package: core

The core package is a shared library containing Cosmos logic, on-chain tool functions, and server utilities. It is **not** an MCP server itself -- it exports building blocks that chain, lease, fred, and cosmwasm packages compose into servers. HTTP clients for provider/Fred APIs are **not** in core; they live in the fred package.

### Source layout

```
src/
├── index.ts              Re-exports all public API
├── logger.ts             Leveled logger (stderr output; level set via logger.setLevel(), defaults to warn)
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
└── tools/                On-chain tool functions (used by lease and fred packages)
    ├── getBalance.ts            On-chain + credit balance
    ├── fundCredits.ts           Send tokens to billing account
    ├── setItemCustomDomain.ts   Claim or release a custom domain on a lease item
    └── stopApp.ts               Close lease on-chain
```

### Key components

**CosmosClientManager** (`client.ts`) -- Keyed-instance cache that manages client lifecycle. Instances are keyed by `chainId:rpcUrl[:restUrl]` (the `restUrl` segment is appended only when configured, so query-only mode keys as `chainId::restUrl`). Supports two operating modes:
- **Full mode** (`rpcUrl` + `gasPrice`): queries via RPC or LCD, transactions via signing client
- **Query-only mode** (`restUrl` only): queries via LCD/REST, `getSigningClient()` throws `INVALID_CONFIG`
- When both `rpcUrl` and `restUrl` are configured, `restUrl` is preferred for queries

Key features:
- Lazy initialization with promise-based concurrency control (multiple callers wait for the same init)
- Token-bucket rate limiting (default: 10 requests/sec via `limiter`), acquired by callers before chain calls
- Automatic retry with exponential backoff (base 1s, max 10s, 3 retries) on transient failures (network errors, HTTP 5xx, 429); permanent errors (`INVALID_CONFIG`, `WALLET_NOT_CONNECTED`, `WALLET_CONNECTION_FAILED`, `INVALID_MNEMONIC`, `INVALID_ADDRESS`, `UNSUPPORTED_QUERY`, `UNSUPPORTED_TX`, `UNKNOWN_MODULE`, `TX_FAILED`) are not retried
- Selective invalidation on config update: signing client is recreated when `gasPrice`, `gasMultiplier`, or `walletProvider` changes; the rate limiter is rebuilt independently when `requestsPerSecond` changes; the query client is never invalidated (stateless HTTP)

**Module registry** (`modules.ts`) -- Static `QUERY_MODULES` and `TX_MODULES` maps that register each Cosmos module's metadata (description, subcommands) and handler functions. This powers the `list_modules` and `list_module_subcommands` discovery tools, allowing AI clients to explore available operations dynamically.

**cosmosQuery / cosmosTx** (`cosmos.ts`) -- Routes a `(module, subcommand, args)` tuple to the correct query or transaction handler by looking up the module registry.

**LCD adapter** (`lcd-adapter.ts`) -- Adapts the LCD/REST client from manifestjs to match the `ManifestQueryClient` shape used by RPC, making the rest of the codebase transport-agnostic. For each LCD module method, the adapter: (1) calls the original LCD method, (2) converts the snake_case JSON response to camelCase via `snakeToCamelDeep()`, (3) runs the result through the matching protobuf `fromJSON` converter. Modules without LCD support (`cosmos.orm.query.v1alpha1`, `liftedinit.manifest.v1`) return proxy objects that throw `UNSUPPORTED_QUERY` on access.

**Server utilities** (`server-utils.ts`) -- Shared by chain, lease, fred, and cosmwasm packages: `withErrorHandling` (wraps tool handlers with error sanitization), `jsonResponse` (formats successful text responses), `structuredResponse` (formats responses with `structuredContent` for tools that declare an `outputSchema`), `bigIntReplacer` (serializes BigInt), `sanitizeForLogging` (redacts sensitive fields).

**Tool annotation helpers** (`tool-metadata.ts`) -- `readOnlyAnnotations()` and `mutatingAnnotations({ destructive, idempotent? })` produce the standard MCP `ToolAnnotations` (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). `manifestMeta({ broadcasts, estimable })` injects a versioned `_meta.manifest` container (`v: MANIFEST_TOOL_META_VERSION = 1`) for Manifest-specific signals downstream plugins consume.

## Package: chain

The chain package is an MCP server that registers 6 generic Cosmos SDK tools:

| Tool | Purpose |
|------|---------|
| `get_account_info` | Get the active wallet address |
| `cosmos_query` | Execute any Cosmos SDK query |
| `cosmos_tx` | Execute any Cosmos SDK transaction |
| `cosmos_estimate_fee` | Estimate gas/fee for a transaction without broadcasting |
| `list_modules` | Discover available query/tx modules |
| `list_module_subcommands` | Discover subcommands for a module |

The `ChainMCPServer` class takes a `ManifestMCPServerOptions` (config + walletProvider), creates an `McpServer`, and registers the 6 tools using core's `cosmosQuery`, `cosmosTx`, `cosmosEstimateFee`, and module registry functions.

## Package: lease

The lease package is an MCP server that registers 8 on-chain lease tools:

| Tool | Purpose |
|------|---------|
| `credit_balance` | Query on-chain credit balance (defaults to the caller; accepts `tenant`) |
| `fund_credit` | Send tokens to a billing credit account (defaults to the sender; accepts `tenant`) |
| `leases_by_tenant` | Query leases by tenant and state (defaults to the caller; accepts `tenant`) |
| `close_lease` | Close a lease on-chain |
| `set_item_custom_domain` | Claim or release a custom domain on a lease item |
| `lease_by_custom_domain` | Look up the lease that owns a custom domain |
| `get_skus` | List available SKUs |
| `get_providers` | List available providers |

The lease server performs purely on-chain operations using core's tool functions and Cosmos query/transaction routing. It does not call any off-chain HTTP APIs.

## Package: fred

The fred package is an MCP server that registers 11 provider/Fred-dependent tools:

| Tool | Purpose |
|------|---------|
| `browse_catalog` | List providers + SKU pricing with health checks |
| `check_deployment_readiness` | Pre-flight checks (balance, SKU availability, image pull) before `deploy_app` |
| `build_manifest_preview` | Preview the SDL/manifest that `deploy_app` would submit |
| `deploy_app` | Create lease + deploy container (optional custom-domain claim and stack `service_name`) |
| `wait_for_app_ready` | Poll provider until a deployed app reports ready |
| `app_status` | Lease status + provider info |
| `get_logs` | Fetch container logs |
| `restart_app` | Restart via provider API |
| `update_app` | Update container manifest |
| `app_diagnostics` | Provision diagnostics (status, failure count, last error) |
| `app_releases` | List deployment release history |

The fred server also registers 3 MCP resources (`manifest://leases/active`, `manifest://leases/recent`, `manifest://providers`) and 3 prompts (`deploy-containerized-app`, `diagnose-failing-app`, `shutdown-all-leases`).

The fred server handles ADR-036 provider authentication internally and contains the HTTP clients for provider and Fred APIs. The package also exports all tool functions and HTTP clients for use by library consumers (e.g., Barney) without requiring the MCP protocol.

### Source layout

```
src/
├── index.ts              FredMCPServer entry point + library exports (constructs the McpServer and wires registerTools/registerResources/registerPrompts)
├── manifest.ts           Manifest building, merging, validation, and meta-hash derivation
├── server/
│   ├── progress.ts             Helper utilities for emitting `notifications/progress` and forwarding `AbortSignal`
│   ├── register-tools.ts       Registers the 11 MCP tools (browse_catalog, deploy_app, app_status, app_diagnostics, app_releases, …)
│   ├── register-resources.ts   Registers the 3 MCP resources (`manifest://leases/active`, `manifest://leases/recent`, `manifest://providers`)
│   └── register-prompts.ts     Registers the 3 MCP prompts (`deploy-containerized-app`, `diagnose-failing-app`, `shutdown-all-leases`)
├── http/
│   ├── auth.ts                 ADR-036 sign-message construction, base64 token assembly, and timestamp deduplication tracker
│   ├── auth-token-service.ts   Cached ADR-036 token issuance keyed by tenant/lease/operation
│   ├── provider.ts             Provider API client (URL validation, health, lease info, manifest upload)
│   └── fred.ts                 Fred API client (lease status, logs, provision diagnostics, restart, update, releases, ready polling)
└── tools/
    ├── fetchActiveLease.ts        Shared helper: resolve a tenant's most recent active lease
    ├── resolveLeaseProvider.ts    Provider API URL lookup from a lease's provider UUID
    ├── browseCatalog.ts           List providers + SKU pricing with health checks
    ├── checkDeploymentReadiness.ts  Pre-flight balance/SKU/image checks before deploy
    ├── buildManifestPreview.ts    Render the SDL/manifest that deploy_app would submit
    ├── deployApp.ts               Create lease + deploy container (+ optional custom-domain claim)
    ├── waitForAppReady.ts         Poll provider until lease reports ready
    ├── appStatus.ts               Lease status + provider info
    ├── getLogs.ts                 Fetch container logs
    ├── restartApp.ts              Restart via provider API
    └── updateApp.ts               Update container manifest
```

`app_diagnostics` and `app_releases` are registered inline in `server/register-tools.ts` rather than as standalone files in `tools/` because they are thin pass-throughs to the matching Fred API endpoints with no orchestration logic to extract.

### HTTP clients

The fred package contains three HTTP client modules that are not in core (to keep core browser-compatible without HTTP client dependencies):

- **`http/auth.ts`** -- ADR-036 token construction. No network calls; pure functions that build sign messages and assemble base64 bearer tokens.
- **`http/provider.ts`** -- Provider API client: `checkedFetch()` (fetch wrapper with timeout and error normalization), `uploadLeaseData()`, `getLeaseConnectionInfo()`, `getProviderHealth()`. All provider URLs are validated to require HTTPS (localhost HTTP allowed for development).
- **`http/fred.ts`** -- Fred API client: `getLeaseStatus()`, `getLeaseLogs()`, `getLeaseProvision()`, `restartLease()`, `updateLease()`, `getLeaseReleases()`, and `pollLeaseUntilReady()` (polls status at 3-second intervals with 120-second timeout, AbortSignal support, and progress callbacks).

### Deployment flow (`deploy_app`)

The most complex operation, orchestrating on-chain and off-chain steps:

```
1.  Build manifest        buildManifest({ image, ports }) or buildStackManifest({ services })
2.  Hash manifest         SHA-256 of JSON string -> metaHashHex
3.  Find SKU              Query chain for SKU UUID and provider UUID matching requested size (e.g., "docker-micro")
4.  Resolve provider      Query chain for provider API URL from SKU's provider UUID
5.  Create lease (tx)     cosmosTx('billing', 'create-lease', ['--meta-hash', metaHashHex, ...leaseItems])
6.  Extract lease UUID    Parse from transaction events
6a. Set custom domain     If `custom_domain` was supplied: cosmosTx('billing', 'set-item-custom-domain', ...)
                          Failure here is wrapped as a partial-success error with `lease_uuid` so the caller
                          can either retry the domain claim or close the orphaned lease.
7.  Upload manifest       POST manifest bytes to provider with ADR-036 auth + meta_hash
8.  Poll until ready      GET lease status until ACTIVE (or terminal state / timeout)
9.  Get connection info   GET connection details (host, ports) -- best-effort, non-fatal
```

If steps 7-8 fail after the on-chain lease is created, the error includes `lease_uuid`, `provider_uuid`, and `provider_url` so the caller can close the orphaned lease.

### Manifest format

Stack manifests use the `{ services: { ... } }` wrapper format. The `buildManifest()` function constructs single-service manifests while `buildStackManifest()` constructs multi-service stacks. Upload payloads are `Uint8Array`.

## Package: cosmwasm

The cosmwasm package is an MCP server that registers 2 MFX-to-PWR converter tools:

| Tool | Purpose |
|------|---------|
| `get_mfx_to_pwr_rate` | Query the converter contract config for the current rate, optionally preview a conversion amount |
| `convert_mfx_to_pwr` | Execute an MFX-to-PWR conversion via the on-chain converter contract |

The `CosmwasmMCPServer` class takes a `CosmwasmMCPServerOptions` (config + walletProvider + converterAddress), creates an `McpServer`, and registers the 2 tools. It queries the converter contract's `{"config":{}}` smart query for rate and denom info, and executes conversions via `MsgExecuteContract` with `{"convert":{}}`. Requires the `MANIFEST_CONVERTER_ADDRESS` environment variable.

## Package: node

The node package provides four Node.js CLI entry points:

- **`manifest-mcp-chain`** (`chain.ts`) -- Spawns `ChainMCPServer` with stdio transport
- **`manifest-mcp-lease`** (`lease.ts`) -- Spawns `LeaseMCPServer` with stdio transport
- **`manifest-mcp-fred`** (`fred.ts`) -- Spawns `FredMCPServer` with stdio transport
- **`manifest-mcp-cosmwasm`** (`cosmwasm.ts`) -- Spawns `CosmwasmMCPServer` with stdio transport

All four entry points share the same wallet resolution and subcommand handling:

1. **Wallet resolution** -- Checks for a keyfile first (`KeyfileWalletProvider`, supports both encrypted and plaintext formats), falls back to a BIP-39 mnemonic env var (`MnemonicWalletProvider`)
2. **Transport binding** -- Connects the server to a `StdioServerTransport`
3. **CLI subcommands** -- `keygen` and `import` for wallet management (interactive, password-protected)

```
src/
├── bootstrap.ts          Shared CLI bootstrap (wallet resolution, transport, error handling)
├── chain.ts              Chain CLI entry point
├── lease.ts              Lease CLI entry point
├── fred.ts               Fred CLI entry point
├── cosmwasm.ts           CosmWasm CLI entry point
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

Errors use the `ManifestMCPErrorCode` enum (12 codes across 6 categories):

| Category | Codes |
|----------|-------|
| Configuration | `INVALID_CONFIG` |
| Wallet | `WALLET_NOT_CONNECTED`, `WALLET_CONNECTION_FAILED`, `INVALID_MNEMONIC` |
| Client/RPC | `RPC_CONNECTION_FAILED` |
| Query | `QUERY_FAILED`, `UNSUPPORTED_QUERY`, `INVALID_ADDRESS` |
| Transaction | `TX_FAILED`, `UNSUPPORTED_TX`, `SIMULATION_FAILED` |
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

All MCP server output goes to **stderr** because stdout is reserved for the MCP JSON-RPC protocol. The leveled logger (`core/src/logger.ts`) supports `debug`, `info`, `warn`, `error`, and `silent` (default: `warn`). The level is set explicitly via `logger.setLevel()`.

`LOG_LEVEL` is a node-level concern: the node package's `bootstrap()` reads `process.env.LOG_LEVEL` after `.env` loads and calls `logger.setLevel(parseLogLevel(...))`. Core's logger has no knowledge of env vars, keeping core compatible with `platform: "neutral"` consumers (e.g. browser).

## E2E testing

End-to-end tests live in `/e2e/` and run against a real Manifest chain (and a real `providerd` for fred tests) via Docker Compose. Each `*.e2e.test.ts` spawns the relevant MCP server in a child process and drives it through the SDK's stdio transport (see `helpers/mcp-client.ts`). The chain image is built from the pinned `submodules/manifest-ledger` commit and the provider image is built from `submodules/fred`.

```
e2e/
├── docker-compose.yml                Spins up chain + init + docker-backend + providerd + faucet (TLS)
├── vitest.config.ts                  5-minute test timeout, single-fork pool
├── docker/                           Dockerfiles for the chain and provider containers
├── scripts/
│   ├── init_chain.sh                 Genesis + key/funds bootstrap for the chain container
│   ├── init_billing.sh               Registers the test provider, mints tokens, creates SKUs
│   └── start_faucet.sh               Boots the CosmJS faucet against the test chain
├── helpers/
│   ├── global-setup.ts               Compose readiness probes + funded-wallet provisioning
│   └── mcp-client.ts                 Spawns MCP server child processes + a `callTool` helper
├── chain-tools.e2e.test.ts           Chain server tool surface (queries, transactions, fee estimation)
├── chain-routing.e2e.test.ts         cosmos_query/cosmos_tx routing across modules and aliases
├── billing-custom-domain.e2e.test.ts set/lookup/clear custom domains via lease + chain layers
├── billing-sku-lifecycle.e2e.test.ts SKU module: create/update/deactivate provider and SKU
├── group-lifecycle.e2e.test.ts       Group module: create-group, policies, proposals, votes
├── deploy-roundtrip.e2e.test.ts      Fred deploy → ready → status → close happy path
├── lifecycle.e2e.test.ts             Full deploy/status/logs/restart/update/close lifecycle
├── cosmwasm.e2e.test.ts              MFX→PWR converter rate query and conversion tx
├── rest-mode.e2e.test.ts             Query-only mode (`COSMOS_REST_URL`) parity coverage
├── retry.e2e.test.ts                 Transient-error retry classification end-to-end
├── errors.e2e.test.ts                Error-code surface for the documented MCP error contract
├── misc-edges.e2e.test.ts            Edge cases that cross modules (pagination, denoms, …)
├── tool-annotations.e2e.test.ts      Pins the `annotations` + `_meta.manifest` matrix per tool
├── wallet.e2e.test.ts                Wallet bootstrap, ADR-036, dual-wallet flows
├── wasm-mutations.e2e.test.ts        Wasm tx surface (store-code, instantiate, execute, migrate)
└── request-faucet.e2e.test.ts        `request_faucet` tool wired against the local CosmJS faucet
```

To run:

```bash
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
```

## Build and test

- **Build**: `tsdown` (unbundled ESM output with sourcemaps and `.d.ts` declarations). Core, chain, lease, fred, and cosmwasm use `platform: "neutral"` for browser compatibility; node uses `platform: "node"`.
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
