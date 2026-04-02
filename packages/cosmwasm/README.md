# @manifest-network/manifest-mcp-cosmwasm

MCP server for Manifest MFX-to-PWR converter contract operations. Registers 2 tools for querying conversion rates and executing token conversions via the on-chain CosmWasm converter contract.

## Installation

```bash
npm install @manifest-network/manifest-mcp-cosmwasm
```

## Tools

| Tool | Description |
|------|-------------|
| `get_mfx_to_pwr_rate` | Get the current MFX-to-PWR conversion rate and optionally preview a conversion amount |
| `convert_mfx_to_pwr` | Convert MFX tokens to PWR via the on-chain converter contract |

## Usage

### As an MCP server (via node package)

See [`packages/node/README.md`](https://github.com/manifest-network/manifest-mcp-mono/blob/main/packages/node/README.md) for CLI usage and MCP client integration.

Requires the `MANIFEST_CONVERTER_ADDRESS` environment variable set to the CosmWasm converter contract address.

### As a library

```typescript
import { CosmwasmMCPServer } from '@manifest-network/manifest-mcp-cosmwasm';

const server = new CosmwasmMCPServer({
  config,            // ManifestMCPConfig from core
  walletProvider,    // WalletProvider from core
  converterAddress,  // CosmWasm converter contract address
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
