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

- Node.js >= 18
- npm >= 9 (ships with Node 18+)

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

```bash
# Build all packages
npm run build

# Lint (type-check)
npm run lint

# Run tests
npm run test
```

## License

MIT
