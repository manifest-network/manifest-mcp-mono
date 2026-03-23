# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Build all packages (tsdown, unbundled ESM)
npm run lint           # Type-check all packages (tsc --noEmit)
npm run test           # Unit tests all packages (vitest)
npm run check          # Lint, format, and import sorting check via biome
npm run check:fix      # Auto-fix biome issues
npm run format         # Format all packages via biome
npm run test:e2e       # E2E tests against live chain (requires docker-compose up)

# Per-package (run from packages/core, packages/chain, packages/lease, packages/fred, or packages/node)
npm run build          # tsdown
npm run lint           # tsc --noEmit
npm run test           # vitest run
npm run test:watch     # vitest (watch mode)

# Single test file
npx vitest run packages/core/src/cosmos.test.ts

# E2E setup
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
```

## Architecture

Three MCP servers bridging AI assistants to Cosmos SDK blockchains (Manifest Network). Five npm workspace packages with strict dependency direction: **node -> {chain, lease, fred} -> core** (never reverse; node also depends on core directly).

- **`packages/core`** -- Shared library. Cosmos logic, on-chain tool functions, server utilities, LCD/REST adapter (`lcd-adapter.ts`). No HTTP clients (those live in fred). Not an MCP server itself. Built with `platform: "neutral"` for browser compatibility.
- **`packages/chain`** -- MCP server with 5 chain tools: `get_account_info`, `cosmos_query`, `cosmos_tx`, `list_modules`, `list_module_subcommands`.
- **`packages/lease`** -- MCP server with 6 on-chain lease tools: `credit_balance`, `fund_credit`, `leases_by_tenant`, `close_lease`, `get_skus`, `get_providers`.
- **`packages/fred`** -- MCP server with 8 provider/Fred tools: `browse_catalog`, `deploy_app`, `app_status`, `get_logs`, `restart_app`, `update_app`, `app_diagnostics`, `app_releases`. Contains HTTP clients (auth, provider, fred) and tool implementations. Also exports all tool functions and HTTP clients for library consumers. Stack manifests use `{ services: { ... } }` wrapper format; upload payloads are `Uint8Array`.
- **`packages/node`** -- Three CLI entry points (`manifest-mcp-chain`, `manifest-mcp-lease`, `manifest-mcp-fred`) with stdio transport + keyfile wallet. Each also supports `keygen` and `import` subcommands for key management.

### Tool layers (3 tiers)

1. **Discovery** -- `list_modules`, `list_module_subcommands` -> powered by static registry in `modules.ts`
2. **Generic chain** -- `cosmos_query`, `cosmos_tx`, `get_account_info` -> routed through `cosmos.ts` to per-module handlers in `queries/` and `transactions/`
3. **High-level Manifest** -- on-chain lease tools in `packages/lease` (using core's tool functions) and provider-dependent tools in `packages/fred` (composing chain operations with provider HTTP calls)

### Key components

- **`CosmosClientManager`** (`client.ts`) -- Keyed singleton (per `chainId:rpcUrl:restUrl`), lazy init with promise dedup, token-bucket rate limiting via `limiter`, callers call `acquireRateLimit()` before RPC. Supports two modes: full mode (rpcUrl + gasPrice for queries + transactions) and query-only mode (restUrl only, signing throws `INVALID_CONFIG`). When `restUrl` is configured it is preferred for queries even if `rpcUrl` is also present.
- **`lcd-adapter.ts`** (core) -- Adapts the LCD/REST client from manifestjs to match the `ManifestQueryClient` shape used by RPC. Converts snake_case LCD responses to camelCase via `snakeToCamelDeep`, then runs them through protobuf `fromJSON` converters. Modules without LCD support (e.g., `cosmos.orm`, `liftedinit.manifest`) return `unsupportedModule` proxies that throw `UNSUPPORTED_QUERY` on access.
- **Module registry** (`modules.ts`) -- `QUERY_MODULES` / `TX_MODULES` maps: metadata + handler function per module. Adding a module = add handler file + register in map.
- **`cosmos.ts`** -- Routes `(module, subcommand, args)` -> handler. Wraps in `withRetry()` and rate limiting.
- **`server-utils.ts`** -- Shared server utilities: `withErrorHandling`, `jsonResponse`, `bigIntReplacer`, `sanitizeForLogging`, `ManifestMCPServerOptions`, `createMnemonicServer`.
- **`http/auth.ts`** (fred package) -- ADR-036 client-side auth tokens (signed message -> base64 Bearer token with embedded unix epoch timestamp; expiry enforced server-side). No auth endpoint round-trip. Token payload uses `meta_hash` (not `meta_hash_hex`) and `timestamp` is a number (unix seconds).
- **`http/provider.ts` / `http/fred.ts`** (fred package) -- Off-chain provider API clients with timeout handling.

### Wallet resolution (node package)

`packages/node/src/bootstrap.ts` resolves wallet in order: keyfile (`MANIFEST_KEY_FILE`, encrypted or plaintext) -> mnemonic env var (`COSMOS_MNEMONIC`) -> fatal exit with usage instructions. All three entry points (`chain.ts`, `lease.ts`, and `fred.ts`) delegate to this shared bootstrap. All wallet providers implement `WalletProvider` interface from core including optional `signArbitrary` for ADR-036.

### Error handling

`ManifestMCPError` with `ManifestMCPErrorCode` enum (14 codes, 6 categories). Error responses are sanitized via `sanitizeForLogging()` which redacts sensitive fields (mnemonics, passwords, keys, tokens). Retry logic (`retry.ts`) classifies errors as transient vs permanent -- only transient errors (connection, 5xx, 429) are retried.

## Conventions

- ESM-only (`"type": "module"`). Use `.js` extensions in imports (e.g., `'./client.js'`).
- `tsdown` builds unbundled ESM with `.d.ts` and sourcemaps. Not tsc. Core/chain/lease/fred use `platform: "neutral"` (`.js` output); node uses `platform: "node"` (`.js` output, ESM via package.json type).
- Tests are co-located `*.test.ts` files. E2E tests live in `/e2e/`.
- Query handlers: `routeXxxQuery(queryClient, subcommand, args)` with switch on subcommand.
- Transaction handlers: `routeXxxTransaction(client, senderAddress, subcommand, args, waitForConfirmation)`.
- Input validation via helpers in `validation.ts` (`requireString`, `requireStringEnum`, `requireUuid`, `parseArgs`, `optionalBoolean`).
- BigInt values serialized to strings via `bigIntReplacer` JSON replacer.
- `@cosmjs/stargate` is overridden to `@manifest-network/stargate` (custom fork). See core `package.json` overrides.
- Code formatting, linting, and import sorting enforced by Biome (see `biome.json`). Run `npm run check` before committing.

## Environment variables (node package)

| Variable | Required | Default |
|----------|----------|---------|
| `COSMOS_CHAIN_ID` | Yes | -- |
| `COSMOS_RPC_URL` | One of `COSMOS_RPC_URL` or `COSMOS_REST_URL` required | -- |
| `COSMOS_GAS_PRICE` | Required when `COSMOS_RPC_URL` is set | -- |
| `COSMOS_REST_URL` | One of `COSMOS_RPC_URL` or `COSMOS_REST_URL` required | -- |
| `COSMOS_ADDRESS_PREFIX` | No | `manifest` |
| `MANIFEST_KEY_FILE` | No | `~/.manifest/key.json` |
| `MANIFEST_KEY_PASSWORD` | No | -- |
| `COSMOS_MNEMONIC` | No | -- |
| `LOG_LEVEL` | No | `warn` |

`LOG_LEVEL` accepts `debug`, `info`, `warn`, `error`, or `silent`. Logs go to stderr.

Set `COSMOS_RPC_URL` + `COSMOS_GAS_PRICE` for full access (queries + transactions). Set `COSMOS_REST_URL` alone for query-only mode (LCD/REST). When both are set, `COSMOS_REST_URL` is preferred for queries.

The node package loads `.env` files automatically via `dotenv`.
