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

# Per-package (run from packages/core, packages/chain, packages/lease, packages/fred, packages/cosmwasm, or packages/node)
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

Five MCP servers bridging AI assistants to Cosmos SDK blockchains (Manifest Network). Eight npm workspace packages with strict dependency direction: **node -> {chain, lease, fred, cosmwasm, agent} -> core**, and **agent -> agent-core -> {core, fred}** (never reverse; node also depends on core directly).

- **`packages/core`** -- Shared library. Cosmos logic, on-chain tool functions, server utilities, LCD/REST adapter (`lcd-adapter.ts`). No HTTP clients (those live in fred). Not an MCP server itself. Built with `platform: "neutral"` for browser compatibility.
- **`packages/chain`** -- MCP server with 6 chain tools (+ optional `request_faucet` when `MANIFEST_FAUCET_URL` is set): `get_account_info`, `cosmos_query`, `cosmos_tx`, `cosmos_estimate_fee`, `list_modules`, `list_module_subcommands`.
- **`packages/lease`** -- MCP server with 8 on-chain lease tools: `credit_balance`, `fund_credit`, `leases_by_tenant`, `close_lease`, `set_item_custom_domain`, `lease_by_custom_domain`, `get_skus`, `get_providers`.
- **`packages/fred`** -- MCP server with 11 provider/Fred tools: `browse_catalog`, `deploy_app`, `app_status`, `get_logs`, `restart_app`, `update_app`, `app_diagnostics`, `app_releases`, `check_deployment_readiness`, `build_manifest_preview`, `wait_for_app_ready`. Contains HTTP clients (auth, provider, fred) and tool implementations. Also exports all tool functions and HTTP clients for library consumers. Stack manifests use `{ services: { ... } }` wrapper format; upload payloads are `Uint8Array`. `deploy_app` accepts optional `custom_domain` (FQDN to claim on the freshly-created lease) and `service_name` (required for stack leases).
- **`packages/cosmwasm`** -- MCP server with 2 converter tools: `get_mfx_to_pwr_rate`, `convert_mfx_to_pwr`. Requires `MANIFEST_CONVERTER_ADDRESS` env var. Uses the on-chain MFX→PWR converter contract (CosmWasm smart contract with `{"convert":{}}` execute and `{"config":{}}` query).
- **`packages/agent-core`** -- TypeScript orchestration surface for Manifest agent flows (`deployApp`, `manageDomain`, `troubleshootDeployment`, `closeLease`). Not an MCP server itself — exposes typed callbacks (`onPlan`, `onConfirm`, `onProgress`, `onComplete`, `onFailure`). Built with `platform: "neutral"` (node-only code paths like `saveManifest` use dynamic `node:fs` imports).
- **`packages/agent`** -- MCP server with 4 orchestrated tools wrapping each agent-core function: `deploy_app_orchestrated`, `manage_domain_orchestrated`, `troubleshoot_deployment_orchestrated`, `close_lease_orchestrated`. Translates agent-core callbacks into MCP elicitation (`server.elicitInput`) requests + progress notifications. **Requires** an elicitation-capable host (Claude Code ≥ 2.1.76). Pure adapter — no orchestration logic, no re-rendering of agent-core's `internals/render-*.ts` outputs.
- **`packages/node`** -- Five CLI entry points (`manifest-mcp-chain`, `manifest-mcp-lease`, `manifest-mcp-fred`, `manifest-mcp-cosmwasm`, `manifest-mcp-agent`) with stdio transport + keyfile wallet. Each also supports `keygen` and `import` subcommands for key management.

### Tool layers (3 tiers)

1. **Discovery** -- `list_modules`, `list_module_subcommands` -> powered by static registry in `modules.ts`
2. **Generic chain** -- `cosmos_query`, `cosmos_tx`, `cosmos_estimate_fee`, `get_account_info` -> routed through `cosmos.ts` to per-module handlers in `queries/` and `transactions/`
3. **High-level Manifest** -- on-chain lease tools in `packages/lease` (using core's tool functions), provider-dependent tools in `packages/fred` (composing chain operations with provider HTTP calls), and MFX→PWR converter tools in `packages/cosmwasm` (composing CosmWasm queries with contract execution)
4. **Orchestration (elicitation-driven)** -- four high-level multi-step flows in `packages/agent` wrapping `packages/agent-core`'s `deployApp` / `manageDomain` / `troubleshootDeployment` / `closeLease`. The wrapper translates agent-core's typed callbacks into MCP `elicitation/create` requests + `notifications/progress` events; host surfaces drive the bidirectional flow over standard MCP wire.

### Key components

- **`CosmosClientManager`** (`client.ts`) -- Keyed singleton (per `chainId:rpcUrl[:restUrl]`), lazy init with promise dedup, token-bucket rate limiting via `limiter`, callers call `acquireRateLimit()` before RPC. Supports two modes: full mode (rpcUrl + gasPrice for queries + transactions) and query-only mode (restUrl only, signing throws `INVALID_CONFIG`). When `restUrl` is configured it is preferred for queries even if `rpcUrl` is also present. On config update via `getInstance`, the signing client is invalidated when `gasPrice`, `gasMultiplier`, or `walletProvider` changes; the query client is never invalidated (stateless HTTP); the rate limiter is rebuilt independently when `requestsPerSecond` changes. `disconnect()` is reference-counted per config key (each `getInstance` acquires, each `disconnect` releases), so sibling MCP servers sharing a key tear the shared clients down only when the last holder releases; `clearInstances()` force-tears-down regardless of refCount.
- **`lcd-adapter.ts`** (core) -- Adapts the LCD/REST client from manifestjs to match the `ManifestQueryClient` shape used by RPC. Converts snake_case LCD responses to camelCase via `snakeToCamelDeep`, then runs them through protobuf `fromJSON` converters. Modules without LCD support (e.g., `cosmos.orm`, `liftedinit.manifest`) return `unsupportedModule` proxies that throw `UNSUPPORTED_QUERY` on access.
- **Module registry** (`modules.ts`) -- `QUERY_MODULES` / `TX_MODULES` maps: metadata + handler function per module. Adding a module = add handler file + register in map.
- **`cosmos.ts`** -- Routes `(module, subcommand, args)` -> handler. Wraps in `withRetry()` and rate limiting.
- **`server-utils.ts`** -- Shared server utilities: `withErrorHandling`, `jsonResponse`, `bigIntReplacer`, `sanitizeForLogging`, `ManifestMCPServerOptions`, `createMnemonicServer`.
- **`http/auth.ts`** (fred package) -- ADR-036 client-side auth tokens (signed message -> base64 Bearer token with embedded unix epoch timestamp; expiry enforced server-side). No auth endpoint round-trip. Token payload uses `meta_hash` (not `meta_hash_hex`) and `timestamp` is a number (unix seconds).
- **`http/provider.ts` / `http/fred.ts`** (fred package) -- Off-chain provider API clients with timeout handling.

### Wallet resolution (node package)

`packages/node/src/bootstrap.ts` resolves wallet in order: keyfile (`MANIFEST_KEY_FILE`, encrypted or plaintext) -> mnemonic env var (`COSMOS_MNEMONIC`) -> fatal exit with usage instructions. All five entry points (`chain.ts`, `lease.ts`, `fred.ts`, `cosmwasm.ts`, and `agent.ts`) delegate to this shared bootstrap. All wallet providers implement `WalletProvider` interface from core including optional `signArbitrary` for ADR-036.

### Error handling

`ManifestMCPError` with `ManifestMCPErrorCode` enum (12 codes, 6 categories). Error responses are sanitized via `sanitizeForLogging()` which redacts sensitive fields (mnemonics, passwords, keys, tokens). Retry logic (`retry.ts`) classifies errors as transient vs permanent -- only transient errors (connection, 5xx, 429) are retried.

### Tool annotations and `_meta.manifest`

Every `registerTool` call across the five MCP servers must pass two extra fields beyond `description` and `inputSchema`:

- **`annotations`** -- standard MCP `ToolAnnotations` (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Built via the helpers `readOnlyAnnotations(title)` or `mutatingAnnotations(title, { destructive, idempotent? })` exported from core (`tool-metadata.ts`). These are spec-blessed UX hints generic MCP clients consume.
- **`_meta`** -- a `manifestMeta({ broadcasts, estimable })` container under the `manifest` namespace. The helper injects a leading `v: 1` schema version so plugin readers can branch safely as fields evolve. These flags express Manifest-specific signals the standard annotations can't (e.g., `request_faucet` is `readOnlyHint: false` because it mutates external state, but `broadcasts: false` because the agent's wallet doesn't sign). The `manifest-agent` plugin reads `_meta.manifest` to derive its broadcast policy.

Both are advisory hints, not enforcement. The plugin's `PreToolUse` hook regex is the security boundary. The annotation matrix is pinned per tool by `describe('tool annotations + _meta.manifest', ...)` blocks in each `server.test.ts`; treat those tests as the public contract -- changing them is downstream-visible and requires a coordinated plugin update.

## Conventions

- ESM-only (`"type": "module"`). Use `.js` extensions in imports (e.g., `'./client.js'`).
- `tsdown` builds unbundled ESM with `.d.ts` and sourcemaps. Not tsc. Core/chain/lease/fred/cosmwasm/agent-core/agent use `platform: "neutral"` (`.js` output; node-only code paths use dynamic imports — e.g. `agent`'s optional `createGuardedFetch` gated on `MANIFEST_AGENT_FETCH_GUARDED=1`, `agent-core`'s `saveManifest`); node uses `platform: "node"` (`.js` output, ESM via package.json type).
- Tests are co-located `*.test.ts` files. E2E tests live in `/e2e/`.
- Query handlers: `routeXxxQuery(queryClient, subcommand, args)` with switch on subcommand.
- Transaction handlers: `routeXxxTransaction(client, senderAddress, subcommand, args, waitForConfirmation)`.
- Input validation via helpers in `validation.ts` (`requireString`, `requireStringEnum`, `requireUuid`, `parseArgs`, `optionalBoolean`).
- BigInt values serialized to strings via `bigIntReplacer` JSON replacer.
- `@cosmjs/stargate` is overridden to `@manifest-network/stargate` (custom fork). See core `package.json` overrides.
- `ipaddr.js` is force-pinned to `2.4.0` tree-wide via the root `package.json` `overrides`. The agent-core SSRF guard (`guarded-fetch.ts`) treats `ipaddr.js`'s `range()` as the sole source of truth (default-deny on any non-`'unicast'` label); proxy-addr (transitive via the MCP SDK → express) pulls `ipaddr.js@1.9.1`, whose stale RFC table misclassifies reserved ranges (e.g. `198.18.0.0/15`, `100::/64`) as `'unicast'` and would bypass the guard. Do not remove the override. (ENG-218)
- **Stale/worktree dep drift:** the root `overrides` + lockfile fix the *resolved* version, but the on-disk `node_modules` can still diverge from the lockfile. A freshly-created `git worktree` (under `.claude/worktrees/`) starts with **no** `node_modules` and resolves transitive deps *up* to the repo-root hoisted copy; a checkout that pulled a lockfile change without reinstalling keeps the stale copy. Either can silently load the wrong version of a pinned transitive dep (e.g. `ipaddr.js@1.9.1` instead of the pinned `2.4.0`), false-red/green-ing the SSRF guard tests. Run `npm install` in a new worktree and after pulling lockfile changes. CI is unaffected — it uses `npm ci`, which installs exactly the lockfile. (ENG-220)
- Code formatting, linting, and import sorting enforced by Biome (see `biome.json`). Run `npm run check` before committing.
- Regex matching: prefer `String.prototype.match()` over the corresponding `RegExp` instance method in regex-heavy code. The CI security hook flags certain RegExp-method patterns as shell-execution tokens (false-positive but blocking). See `packages/agent-core/src/internals/evaluate-readiness.ts` (the gasPrice parse — `inputs.gasPrice.match(GAS_PRICE_RE)`) for an in-source example with the rationale called out inline.

## Environment variables (node package)

| Variable | Required | Default |
|----------|----------|---------|
| `COSMOS_CHAIN_ID` | Yes | -- |
| `COSMOS_RPC_URL` | One of `COSMOS_RPC_URL` or `COSMOS_REST_URL` required | -- |
| `COSMOS_GAS_PRICE` | Required when `COSMOS_RPC_URL` is set | -- |
| `COSMOS_REST_URL` | One of `COSMOS_RPC_URL` or `COSMOS_REST_URL` required | -- |
| `COSMOS_GAS_MULTIPLIER` | No | `1.5` (must be >= 1) |
| `COSMOS_ADDRESS_PREFIX` | No | `manifest` |
| `MANIFEST_KEY_FILE` | No | `~/.manifest/key.json` |
| `MANIFEST_KEY_PASSWORD` | No | -- |
| `COSMOS_MNEMONIC` | No | -- |
| `MANIFEST_FAUCET_URL` | No | -- |
| `MANIFEST_CONVERTER_ADDRESS` | Required for cosmwasm server | -- |
| `MANIFEST_AGENT_DATA_DIR` | No (agent server) | -- |
| `MANIFEST_CHAIN_DATA_FILE` | No (agent server) | -- |
| `MANIFEST_AGENT_FETCH_GUARDED` | No (agent server) | `1` (default ON; accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`, case-insensitive) |
| `MANIFEST_AGENT_ELICIT_TIMEOUT_MS` | No (agent server) | `600000` (10 min; per-`elicitInput` timeout) |
| `LOG_LEVEL` | No | `warn` |

`LOG_LEVEL` accepts `debug`, `info`, `warn`, `error`, or `silent`. Logs go to stderr. `LOG_LEVEL` is read by the node package's `bootstrap()` once `.env` has loaded, then applied via `logger.setLevel()`; core's logger has no knowledge of env vars and defaults to `warn`.

Set `COSMOS_RPC_URL` + `COSMOS_GAS_PRICE` for full access (queries + transactions). Set `COSMOS_REST_URL` alone for query-only mode (LCD/REST). When both are set, `COSMOS_REST_URL` is preferred for queries.

The node package loads `.env` files automatically via `dotenv`.
