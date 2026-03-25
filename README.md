# Manifest MCP

MCP servers for [Manifest Network](https://www.manifestai.com/) and Cosmos SDK chains.

Exposes on-chain queries and transactions as [Model Context Protocol](https://modelcontextprotocol.io/) tools, so any MCP-compatible client (Claude Desktop, Cursor, etc.) can interact with the blockchain through natural language.

## Monorepo structure

```
packages/
  core/    @manifest-network/manifest-mcp-core    Shared library: Cosmos logic, on-chain tool functions, server utilities
  chain/   @manifest-network/manifest-mcp-chain   MCP server for chain operations (5 tools)
  lease/   @manifest-network/manifest-mcp-lease   MCP server for on-chain lease operations (6 tools)
  fred/    @manifest-network/manifest-mcp-fred    MCP server for provider/Fred operations (8 tools)
  node/    @manifest-network/manifest-mcp-node    CLI entry points + encrypted keyfile wallet
```

Dependency direction: **node -> {chain, lease, fred} -> core** (never reverse).

## Prerequisites

- Node.js >= 20
- npm >= 9 (ships with Node 20+)

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

### Chain server (`manifest-mcp-chain`) -- 5 tools

| Tool | Description |
|------|-------------|
| `get_account_info` | Get the address of the configured wallet |
| `cosmos_query` | Execute any Cosmos SDK query (bank, staking, gov, etc.) |
| `cosmos_tx` | Sign and broadcast any Cosmos SDK transaction |
| `list_modules` | List all available query and transaction modules |
| `list_module_subcommands` | List subcommands for a specific module |

### Lease server (`manifest-mcp-lease`) -- 6 tools

| Tool | Description |
|------|-------------|
| `credit_balance` | Query on-chain credit balance |
| `fund_credit` | Send tokens to the billing account |
| `leases_by_tenant` | List leases for the current account by state |
| `close_lease` | Close a lease on-chain |
| `get_skus` | List available SKUs |
| `get_providers` | List available providers |

### Fred server (`manifest-mcp-fred`) -- 8 tools

| Tool | Description |
|------|-------------|
| `browse_catalog` | Browse available providers and service tiers with health checks |
| `deploy_app` | Deploy a new application (create lease + deploy container) |
| `app_status` | Get detailed status for a deployed app by lease UUID |
| `get_logs` | Get logs for a deployed app by lease UUID |
| `restart_app` | Restart a deployed app via the provider |
| `update_app` | Update a deployed app with a new manifest |
| `app_diagnostics` | Get provision diagnostics for a deployed app |
| `app_releases` | Get release/version history for a deployed app |

Supported modules: `bank`, `staking`, `distribution`, `gov`, `billing`, `sku`, `group`, `auth` (query only), `manifest` (tx only).

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

All five packages are versioned in lockstep and published together.

### Setup (one-time)

1. Create an npm [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens) with publish permission for the `@manifest-network` scope.
2. Add it as a repository secret named `NPM_TOKEN` in **Settings → Secrets and variables → Actions**.

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
3. Publishes all packages to npm (with [provenance](https://docs.npmjs.com/generating-provenance-statements)) in dependency order: `core → chain → lease → fred → node`
4. Creates a GitHub Release with auto-generated notes (best-effort — publish succeeds even if this fails)

## License

MIT
