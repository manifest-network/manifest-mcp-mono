# @manifest-network/manifest-mcp-fred

MCP server for Manifest provider (Fred) operations. Registers 8 tools for app deployment, status, logs, restart, update, diagnostics, and releases. Composes on-chain operations with off-chain provider HTTP calls using ADR-036 authentication.

This package also **exports all tool functions and HTTP clients** for use by library consumers without requiring the MCP protocol.

## Installation

```bash
npm install @manifest-network/manifest-mcp-fred
```

## Tools

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

## Usage

### As an MCP server (via node package)

See [`packages/node/README.md`](https://github.com/manifest-network/manifest-mcp-mono/blob/main/packages/node/README.md) for CLI usage and MCP client integration.

### As a library

```typescript
// Use the MCP server class
import { FredMCPServer } from '@manifest-network/manifest-mcp-fred';

const server = new FredMCPServer({
  config,          // ManifestMCPConfig from core
  walletProvider,  // WalletProvider from core
});

// Or use individual tool functions and HTTP clients directly
import { deployApp, browseCatalog } from '@manifest-network/manifest-mcp-fred';
import { createAuthToken } from '@manifest-network/manifest-mcp-fred';
```

### HTTP clients

The package contains three HTTP client modules:

- **`http/auth.ts`** -- ADR-036 token construction. Pure functions that build sign messages and assemble base64 bearer tokens. No network calls.
- **`http/provider.ts`** -- Provider API client: `uploadLeaseData()`, `getLeaseConnectionInfo()`, `getProviderHealth()`. All provider URLs require HTTPS (localhost HTTP allowed for development).
- **`http/fred.ts`** -- Fred API client: `getLeaseStatus()`, `getLeaseLogs()`, `getLeaseProvision()`, `restartLease()`, `updateLease()`, `getLeaseReleases()`, `getLeaseInfo()`, and `pollLeaseUntilReady()`.

## Build

```bash
npm run build    # tsdown (platform: neutral)
npm run lint     # tsc --noEmit
npm run test     # vitest
```

## License

MIT
