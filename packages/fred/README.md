# @manifest-network/manifest-mcp-fred

MCP server for Manifest provider (Fred) operations. Registers 11 tools (plus 3 MCP resources and 3 prompts) for catalog browsing, deployment readiness, manifest preview, app deployment, status, logs, restart, update, diagnostics, releases, and ready-state polling. Composes on-chain operations with off-chain provider HTTP calls using ADR-036 authentication.

This package also **exports all tool functions and HTTP clients** for use by library consumers without requiring the MCP protocol.

## Installation

```bash
npm install @manifest-network/manifest-mcp-fred
```

## Tools

| Tool | Description |
|------|-------------|
| `browse_catalog` | Browse available providers and service tiers with health checks |
| `check_deployment_readiness` | Pre-flight checks (balance, credit account, SKU availability) before `deploy_app` |
| `build_manifest_preview` | Preview the manifest and its `meta_hash` that `deploy_app` would submit |
| `deploy_app` | Deploy a new application (create lease + deploy container, optional custom domain) |
| `wait_for_app_ready` | Poll provider until a deployed app reports ready |
| `app_status` | Get detailed status for a deployed app by lease UUID |
| `get_logs` | Get logs for a deployed app by lease UUID |
| `restart_app` | Restart a deployed app via the provider |
| `update_app` | Update a deployed app with a new manifest |
| `app_diagnostics` | Get provision diagnostics for a deployed app |
| `app_releases` | Get release/version history for a deployed app |

## Resources & prompts

The Fred server also exposes 3 MCP resources (`manifest://leases/active`, `manifest://leases/recent`, `manifest://providers`) and 3 prompts (`deploy-containerized-app`, `diagnose-failing-app`, `shutdown-all-leases`).

## Usage

### As an MCP server (via node package)

See [`packages/node/README.md`](https://github.com/manifest-network/manifest-mcp-mono/blob/main/packages/node/README.md) for CLI usage and MCP client integration.

### As a library

```typescript
// Use the MCP server class — Node-only, from the `/server` subpath (NOT the barrel;
// the barrel stays browser-bundleable, see ENG-287)
import { FredMCPServer } from '@manifest-network/manifest-mcp-fred/server';

const server = new FredMCPServer({
  config,          // ManifestMCPConfig from core
  walletProvider,  // WalletProvider from core
});

// Or use individual tool functions and HTTP clients directly (browser-safe barrel)
import { deployApp, browseCatalog } from '@manifest-network/manifest-mcp-fred';
import { createAuthToken } from '@manifest-network/manifest-mcp-fred';
```

> **SSRF guard.** When run as an MCP server, all provider/Fred HTTP is routed through core's SSRF-guarded fetch by default. Toggle it with `MANIFEST_FRED_FETCH_GUARDED` (default on; set `0`/`false`/`no`/`off` to disable — only in trusted local setups).

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
