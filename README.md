# Manifest MCP

[![E2E](https://github.com/manifest-network/manifest-mcp-mono/actions/workflows/e2e.yml/badge.svg)](https://github.com/manifest-network/manifest-mcp-mono/actions/workflows/e2e.yml)

MCP servers for [Manifest Network](https://manifest.network/) and Cosmos SDK chains.

Exposes on-chain queries and transactions as [Model Context Protocol](https://modelcontextprotocol.io/) tools, so any MCP-compatible client (Claude Desktop, Cursor, etc.) can interact with the blockchain through natural language.

**Building a TypeScript app** (not an MCP integration)? Use [`@manifest-network/manifest-sdk`](packages/sdk/README.md) — the app-building SDK that composes the chain + Fred behind one typed client. See its [README](packages/sdk/README.md) and the [SDK cookbook](docs/library-usage.md).

## Monorepo structure

```
packages/
  core/        @manifest-network/manifest-mcp-core      Shared library: Cosmos logic, on-chain tool functions, server utilities
  chain/       @manifest-network/manifest-mcp-chain     MCP server for chain operations (6 tools, +1 optional faucet)
  lease/       @manifest-network/manifest-mcp-lease     MCP server for on-chain lease operations (8 tools)
  fred/        @manifest-network/manifest-mcp-fred      MCP server for provider/Fred operations (11 tools)
  cosmwasm/    @manifest-network/manifest-mcp-cosmwasm  MCP server for MFX-to-PWR converter (2 tools)
  agent-core/  @manifest-network/manifest-agent-core    TypeScript orchestration surface (deploy / manage-domain / troubleshoot / close-lease)
  agent/       @manifest-network/manifest-mcp-agent     MCP server wrapping agent-core via MCP elicitation (5 orchestrated tools)
  node/        @manifest-network/manifest-mcp-node      CLI entry points + encrypted keyfile wallet
  sdk/         @manifest-network/manifest-sdk           App-building SDK: aggregates core + fred + agent-core behind one typed surface (for TS apps, not MCP)
```

Dependency direction: **node -> {chain, lease, fred, cosmwasm, agent} -> core**; **agent -> agent-core -> {core, fred}** (never reverse).

## Prerequisites

- Node.js >= 22.19.0 (enforced via `engines` on every package)
- npm >= 10 (ships with Node 22+)

## Quick start

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Generate an encrypted wallet keyfile (interactive)
npx manifest-mcp-chain keygen
```

See [`packages/node/README.md`](packages/node/README.md) for wallet setup and MCP client integration.

## MCP tools

### Chain server (`manifest-mcp-chain`) -- 6 tools (+1 optional)

| Tool | Description |
|------|-------------|
| `get_account_info` | Get the address of the configured wallet |
| `cosmos_query` | Execute any Cosmos SDK query (bank, staking, gov, etc.) |
| `cosmos_tx` | Sign and broadcast any Cosmos SDK transaction |
| `cosmos_estimate_fee` | Estimate gas + fee for a transaction without broadcasting |
| `list_modules` | List all available query and transaction modules |
| `list_module_subcommands` | List subcommands for a specific module |
| `request_faucet` | Request tokens from a faucet (registered only when `MANIFEST_FAUCET_URL` is set) |

### Lease server (`manifest-mcp-lease`) -- 8 tools

| Tool | Description |
|------|-------------|
| `credit_balance` | Query on-chain credit balance (defaults to the caller; accepts `tenant`) |
| `fund_credit` | Send tokens to a billing credit account (defaults to the sender; accepts `tenant`) |
| `leases_by_tenant` | List leases by state (defaults to the caller; accepts `tenant`) |
| `close_lease` | Close a lease on-chain |
| `set_item_custom_domain` | Claim or release a custom domain on a lease item |
| `lease_by_custom_domain` | Look up the lease that owns a custom domain |
| `get_skus` | List available SKUs |
| `get_providers` | List available providers |

### Fred server (`manifest-mcp-fred`) -- 11 tools

| Tool | Description |
|------|-------------|
| `browse_catalog` | Browse available providers and service tiers with health checks |
| `check_deployment_readiness` | Pre-flight checks (wallet balances, credit account, SKU availability) before `deploy_app` |
| `build_manifest_preview` | Preview the manifest that `deploy_app` would submit |
| `deploy_app` | Deploy a new application (create lease + deploy container, optional custom domain) |
| `wait_for_app_ready` | Poll provider until a deployed app reports ready |
| `app_status` | Get detailed status for a deployed app by lease UUID |
| `get_logs` | Get logs for a deployed app by lease UUID |
| `restart_app` | Restart a deployed app via the provider |
| `update_app` | Update a deployed app with a new manifest |
| `app_diagnostics` | Get provision diagnostics for a deployed app |
| `app_releases` | Get release/version history for a deployed app |

The Fred server also exposes 3 MCP resources (`manifest://leases/active`, `manifest://leases/recent`, `manifest://providers`) and 3 prompts (`deploy-containerized-app`, `diagnose-failing-app`, `shutdown-all-leases`).

### CosmWasm server (`manifest-mcp-cosmwasm`) -- 2 tools

| Tool | Description |
|------|-------------|
| `get_mfx_to_pwr_rate` | Get the current MFX-to-PWR conversion rate and preview amounts |
| `convert_mfx_to_pwr` | Convert MFX tokens to PWR via the on-chain converter contract |

### Agent server (`manifest-mcp-agent`) -- 5 orchestrated tools

Wraps [`@manifest-network/manifest-agent-core`](packages/agent-core/README.md) orchestration via MCP **elicitation** — bidirectional plan / confirm / recovery prompts flow over standard MCP wire. The broadcasting tools require an elicitation-capable host (Claude Code ≥ 2.1.76); the read-only tools (`lookup_custom_domain_orchestrated`, `troubleshoot_deployment_orchestrated`) run on any host.

| Tool | Description |
|------|-------------|
| `deploy_app_orchestrated` | Plan → confirm → broadcast → persist; rich recovery picker on partial-success failures |
| `manage_domain_orchestrated` | Set / clear a lease custom domain with confirm + verify |
| `lookup_custom_domain_orchestrated` | Reverse-resolve an FQDN to its owning lease (read-only chain query, no broadcast) |
| `troubleshoot_deployment_orchestrated` | Generate a markdown chain-side diagnostic report (no broadcast) |
| `close_lease_orchestrated` | Confirm → close → verify terminal state |

Modules reachable via the chain server's `cosmos_query` / `cosmos_tx` (enumerate with `list_modules`): `bank`, `staking`, `distribution`, `gov`, `billing`, `sku`, `group`, `wasm`, `poa`, `tokenfactory`, `ibc-transfer`, `authz`, `feegrant`, `auth` (query only), `mint` (query only), `manifest` (tx only).

## Documentation

| | |
|---|---|
| Per-server CLI + integration | [`packages/node/README.md`](packages/node/README.md) |
| Tool selection & flow guidance | [`docs/tool-selection-guide.md`](docs/tool-selection-guide.md) |
| End-to-end usage examples | [`docs/usage-examples.md`](docs/usage-examples.md) |
| Prompts & resources reference | [`docs/prompts-and-resources.md`](docs/prompts-and-resources.md) |
| Troubleshooting | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Security model | [`docs/security.md`](docs/security.md) |
| **Build a TypeScript app (SDK)** | [`packages/sdk/README.md`](packages/sdk/README.md) |
| SDK cookbook (library deep dive) | [`docs/library-usage.md`](docs/library-usage.md) |
| Architecture | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Security policy & disclosure | [`SECURITY.md`](SECURITY.md) |

## Development

For a deeper look at the codebase design, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

```bash
# Build all packages
npm run build

# Lint (type-check)
npm run lint

# Run unit tests
npm run test

# Run E2E tests (requires Docker)
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
docker compose -f e2e/docker-compose.yml down -v --remove-orphans

# Code formatting and import sorting (Biome)
npm run check        # check only
npm run check:fix    # auto-fix
```

### Adding a new module

1. Create a query handler in `packages/core/src/queries/<module>.ts` implementing `routeXxxQuery()`
2. Create a transaction handler in `packages/core/src/transactions/<module>.ts` implementing `routeXxxTransaction()`
3. Register both in the `QUERY_MODULES` / `TX_MODULES` maps in `packages/core/src/modules.ts`

The module is then automatically available through the `cosmos_query` and `cosmos_tx` tools, and discoverable via `list_modules` and `list_module_subcommands`.

## Releasing

All nine packages are versioned in lockstep and published together.

### Setup (one-time)

The release workflow uses npm OIDC trusted publishing (provenance). No npm token is needed as a repository secret -- authentication is handled automatically via GitHub's OIDC identity provider. Ensure the npm package is [linked to the repository](https://docs.npmjs.com/generating-provenance-statements#linking-a-package-to-a-repository) for provenance to work.

### Publishing a release

```bash
# 1. Bump versions (updates all package.json files and syncs the lockfile)
npm run release:version -- 0.2.0

# 2. Commit and tag
git add -A
git commit -m "chore: release v0.2.0"
git tag v0.2.0

# 3. Push (triggers the release workflow)
git push origin main --tags
```

Pushing a `vMAJOR.MINOR.PATCH` tag triggers the [Release workflow](.github/workflows/release.yml), which:

1. Validates the tag version matches all `package.json` files
2. Builds, type-checks, runs Biome checks, and tests
3. Publishes all packages to npm (with [provenance](https://docs.npmjs.com/generating-provenance-statements)) in dependency order: `core → chain → lease → fred → cosmwasm → agent-core → agent → node → sdk` (the [release workflow](.github/workflows/release.yml) is the source of truth for the list and order)
4. Creates a GitHub Release with auto-generated notes (best-effort — publish succeeds even if this fails)

## License

MIT
