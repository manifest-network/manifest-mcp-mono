# Manifest MCP

MCP server for [Manifest Network](https://www.manifestai.com/) and Cosmos SDK chains.

Exposes on-chain queries and transactions as [Model Context Protocol](https://modelcontextprotocol.io/) tools, so any MCP-compatible client (Claude Desktop, Cursor, etc.) can interact with the blockchain through natural language.

## Monorepo structure

```
packages/
  core/   @manifest-network/manifest-mcp-core   Transport-agnostic server & Cosmos logic
  node/   @manifest-network/manifest-mcp-node   Node.js stdio transport + encrypted keyfile wallet
```

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
npx manifest-mcp-node keygen
```

See [`packages/node/README.md`](packages/node/README.md) for wallet setup and MCP client integration.

## MCP tools

| Tool | Description |
|------|-------------|
| `get_account_info` | Get the address of the configured wallet |
| `cosmos_query` | Execute any Cosmos SDK query (bank, staking, gov, etc.) |
| `cosmos_tx` | Sign and broadcast any Cosmos SDK transaction |
| `list_modules` | List all available query and transaction modules |
| `list_module_subcommands` | List subcommands for a specific module |
| `browse_catalog` | Browse available cloud providers and service tiers |
| `get_balance` | Get account balances, credit status, and spending estimates |
| `list_apps` | List all deployed apps for the current account * |
| `app_status` | Get detailed status for a deployed app by name * |
| `get_logs` | Get logs for a deployed app by name * |

\* `list_apps`, `app_status`, and `get_logs` require an app registry and are only advertised when one is configured (e.g., when using the node package).

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
