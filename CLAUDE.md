# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build          # Build all packages (tsdown, unbundled ESM)
npm run lint           # Type-check all packages (tsc --noEmit)
npm run test           # Unit tests all packages (vitest)
npm run test:e2e       # E2E tests against live chain (requires docker-compose up)

# Per-package (run from packages/core, packages/chain, packages/cloud, or packages/node)
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

Two MCP servers bridging AI assistants to Cosmos SDK blockchains (Manifest Network). Four npm workspace packages with strict dependency direction: **node → chain/cloud → core** (never reverse).

- **`packages/core`** — Shared library. All blockchain logic, tool implementation functions, HTTP clients, server utilities. Not an MCP server itself.
- **`packages/chain`** — MCP server with 5 chain tools: `get_account_info`, `cosmos_query`, `cosmos_tx`, `list_modules`, `list_module_subcommands`.
- **`packages/cloud`** — MCP server with 10 deployment tools: `browse_catalog`, `get_balance`, `fund_credits`, `list_apps`, `app_status`, `get_logs`, `deploy_app`, `stop_app`, `restart_app`, `update_app`.
- **`packages/node`** — Two CLI entry points (`manifest-mcp-chain`, `manifest-mcp-cloud`) with stdio transport + encrypted keyfile wallet.

### Tool layers (3 tiers)

1. **Discovery** — `list_modules`, `list_module_subcommands` → powered by static registry in `modules.ts`
2. **Generic chain** — `cosmos_query`, `cosmos_tx`, `get_account_info` → routed through `cosmos.ts` to per-module handlers in `queries/` and `transactions/`
3. **High-level Manifest** — `deploy_app`, `stop_app`, etc. → orchestration in `tools/` that compose generic chain operations with provider HTTP calls

### Key components

- **`CosmosClientManager`** (`client.ts`) — Keyed singleton (per `chainId:rpcUrl`), lazy init with promise dedup, token-bucket rate limiting via `limiter`, callers call `acquireRateLimit()` before RPC.
- **Module registry** (`modules.ts`) — `QUERY_MODULES` / `TX_MODULES` maps: metadata + handler function per module. Adding a module = add handler file + register in map.
- **`cosmos.ts`** — Routes `(module, subcommand, args)` → handler. Wraps in `withRetry()` and rate limiting.
- **`server-utils.ts`** — Shared server utilities: `withErrorHandling`, `jsonResponse`, `bigIntReplacer`, `sanitizeForLogging`, `ManifestMCPServerOptions`, `createMnemonicServer`.
- **`http/auth.ts`** — ADR-036 client-side auth tokens (signed message → base64 Bearer token, 60s expiry). No auth endpoint round-trip.
- **`http/provider.ts` / `http/fred.ts`** — Off-chain provider API clients with timeout handling.

### Wallet resolution (node package)

`packages/node/src/bootstrap.ts` resolves wallet in order: encrypted keyfile (`MANIFEST_KEY_FILE`) → mnemonic env var (`COSMOS_MNEMONIC`) → error. Both `chain.ts` and `cloud.ts` delegate to this shared bootstrap. Both wallet providers implement `WalletProvider` interface from core including optional `signArbitrary` for ADR-036.

### Error handling

`ManifestMCPError` with `ManifestMCPErrorCode` enum (20 codes, 7 categories). Error responses are sanitized via `sanitizeForLogging()` which redacts sensitive fields (mnemonics, passwords, keys, tokens). Retry logic (`retry.ts`) classifies errors as transient vs permanent — only transient errors (connection, 5xx, 429) are retried.

## Conventions

- ESM-only (`"type": "module"`). Use `.js` extensions in imports (e.g., `'./client.js'`).
- `tsdown` builds unbundled ESM with `.d.ts` and sourcemaps. Not tsc.
- Tests are co-located `*.test.ts` files. E2E tests live in `/e2e/`.
- Query handlers: `routeXxxQuery(queryClient, subcommand, args)` with switch on subcommand.
- Transaction handlers: `routeXxxTransaction(client, senderAddress, subcommand, args, waitForConfirmation)`.
- Input validation via helpers in `validation.ts` (`requireString`, `requireUuid`, `parseArgs`, etc.).
- BigInt values serialized to strings via `bigIntReplacer` JSON replacer.
- `@cosmjs/stargate` is overridden to `@manifest-network/stargate` (custom fork). See core `package.json` overrides.

## Environment variables (node package)

| Variable | Required | Default |
|----------|----------|---------|
| `COSMOS_CHAIN_ID` | Yes | — |
| `COSMOS_RPC_URL` | Yes | — |
| `COSMOS_GAS_PRICE` | Yes | — |
| `COSMOS_ADDRESS_PREFIX` | No | `manifest` |
| `MANIFEST_KEY_FILE` | No | `~/.manifest/key.json` |
| `MANIFEST_KEY_PASSWORD` | No | — |
| `COSMOS_MNEMONIC` | No | — |
