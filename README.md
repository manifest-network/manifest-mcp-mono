# Manifest MCP

MCP server for [Manifest Network](https://www.manifestai.com/) and Cosmos SDK chains.

Exposes on-chain queries and transactions as [Model Context Protocol](https://modelcontextprotocol.io/) tools, so any MCP-compatible client (Claude Desktop, Cursor, etc.) can interact with the blockchain through natural language.

## Monorepo structure

```
packages/
  core/    @manifest-network/manifest-mcp-core    Shared library: Cosmos logic, tool functions, server utilities
  chain/   @manifest-network/manifest-mcp-chain   MCP server for chain operations (5 tools)
  cloud/   @manifest-network/manifest-mcp-cloud   MCP server for cloud deployments (10 tools)
  node/    @manifest-network/manifest-mcp-node    CLI entry points + encrypted keyfile wallet
```

Dependency direction: **node → chain/cloud → core** (never reverse).

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

### Chain server (`manifest-mcp-chain`) — 5 tools

| Tool | Description |
|------|-------------|
| `get_account_info` | Get the address of the configured wallet |
| `cosmos_query` | Execute any Cosmos SDK query (bank, staking, gov, etc.) |
| `cosmos_tx` | Sign and broadcast any Cosmos SDK transaction |
| `list_modules` | List all available query and transaction modules |
| `list_module_subcommands` | List subcommands for a specific module |

### Cloud server (`manifest-mcp-cloud`) — 10 tools

| Tool | Description |
|------|-------------|
| `browse_catalog` | Browse available cloud providers and service tiers |
| `get_balance` | Get account balances, credit status, and spending estimates |
| `fund_credits` | Fund the credit account for deploying apps |
| `list_apps` | List all leases for the current account |
| `app_status` | Get detailed status for a deployed app by lease UUID |
| `get_logs` | Get logs for a deployed app by lease UUID |
| `deploy_app` | Deploy a new application |
| `stop_app` | Stop a deployed app by closing its lease on-chain |
| `restart_app` | Restart a deployed app via the provider |
| `update_app` | Update a deployed app with a new manifest |

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
