# @manifest-network/manifest-mcp-lease

MCP server for Manifest on-chain lease operations. Registers 6 tools for credit management, lease queries, SKUs, and providers. Performs purely on-chain operations -- no off-chain HTTP calls.

## Installation

```bash
npm install @manifest-network/manifest-mcp-lease
```

## Tools

| Tool | Description |
|------|-------------|
| `credit_balance` | Query on-chain credit balance |
| `fund_credit` | Send tokens to the billing account |
| `leases_by_tenant` | List leases for the current account by state |
| `close_lease` | Close a lease on-chain |
| `get_skus` | List available SKUs |
| `get_providers` | List available providers |

## Usage

### As an MCP server (via node package)

See [`packages/node/README.md`](https://github.com/manifest-network/manifest-mcp-mono/blob/main/packages/node/README.md) for CLI usage and MCP client integration.

### As a library

```typescript
import { LeaseMCPServer } from '@manifest-network/manifest-mcp-lease';

const server = new LeaseMCPServer({
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
