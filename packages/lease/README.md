# @manifest-network/manifest-mcp-lease

MCP server for Manifest on-chain lease operations. Registers 8 tools for credit management, lease queries, custom-domain claim/lookup, SKUs, and providers. Performs purely on-chain operations -- no off-chain HTTP calls.

## Installation

```bash
npm install @manifest-network/manifest-mcp-lease
```

## Tools

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
