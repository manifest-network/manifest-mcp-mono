# @manifest-network/manifest-mcp-chain

MCP server for generic Cosmos SDK chain operations. Registers 5 tools for queries, transactions, and module discovery.

## Installation

```bash
npm install @manifest-network/manifest-mcp-chain
```

## Tools

| Tool | Description |
|------|-------------|
| `get_account_info` | Get the address of the configured wallet |
| `cosmos_query` | Execute any Cosmos SDK query (bank, staking, gov, etc.) |
| `cosmos_tx` | Sign and broadcast any Cosmos SDK transaction |
| `list_modules` | List all available query and transaction modules |
| `list_module_subcommands` | List subcommands for a specific module |

## Usage

### As an MCP server (via node package)

See [`packages/node/README.md`](../node/README.md) for CLI usage and MCP client integration.

### As a library

```typescript
import { ChainMCPServer } from '@manifest-network/manifest-mcp-chain';

const server = new ChainMCPServer({
  config,          // ManifestMCPConfig from core
  walletProvider,  // WalletProvider from core
});
```

## Build

```bash
npm run build    # tsdown (platform: neutral)
npm run lint     # tsc --noEmit
npm run test     # vitest
```

## License

MIT
