# @manifest-network/manifest-mcp-fred

MCP server for Manifest provider (Fred) operations. Registers 12 tools (plus 3 MCP resources and 3 prompts) for catalog browsing, deployment readiness, manifest preview, app deployment, status, logs, restart, update, restore, diagnostics, releases, and ready-state polling. Composes on-chain operations with off-chain provider HTTP calls using ADR-036 authentication.

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
| `build_manifest_preview` | Preview the manifest and its `meta_hash_hex` that `deploy_app` would submit |
| `deploy_app` | Deploy a new application (create lease + deploy container, optional custom domain) |
| `wait_for_app_ready` | Poll provider until a deployed app reports ready |
| `app_status` | Get detailed status for a deployed app by lease UUID |
| `get_logs` | Get logs for a deployed app by lease UUID |
| `restart_app` | Restart a deployed app via the provider |
| `update_app` | Update a deployed app with a new manifest |
| `restore_app` | Restore a CLOSED or EXPIRED app with retained data onto a fresh lease |
| `app_diagnostics` | Get chain state and surviving provider provision diagnostics, including terminal leases |
| `app_releases` | Get release/version history for a deployed app (20 most recent; the stored manifest is omitted, its size reported as `manifest_bytes`) |

Clients, MCP servers, and raw HTTP helpers default to Fred **v0.13**. In this mode `restart_app` and `update_app` omit the `Idempotency-Key` header and returned `idempotency_key`; supplied keys are rejected locally. After an uncertain result, reconcile app status and releases before deliberately submitting another command. No mode automatically replays maintenance POSTs.

Explicit **PR240** mode accepts a canonical UUIDv4 `idempotency_key` and returns it. Preserve that key and the exact command for intentional retries: a timeout or 503 can leave work pending for provider recovery. Omitting the key generates a new command. SDK equivalents use `LifecycleCallOptions.idempotencyKey`; result keys are optional because legacy responses omit them. See [maintenance command identity](../../docs/library-usage.md#restarting-and-updating-with-a-command-key).

`restore_app` creates a new lease and adopts the source's retained data in separate steps. Every restore POST exception, including all HTTP 4xx/5xx, network failures, and malformed 2xx responses, leaves adoption **unknown**: preserve both lease IDs, check `app_status` / `app_diagnostics`, and reconcile with the provider before retrying or considering cleanup. The SDK does not cancel an uncertain target or advise doing so. A PENDING chain state alone does not establish that no volumes were adopted, and a 429 `Retry-After` does not authorize replay. Only locally known failures or cancellation before the restore POST begins permit automatic compensation. See [restore outcomes and cancellation](../../docs/library-usage.md#restoring-a-closed-lease) for the structured error fields.

## Resources & prompts

The Fred server also exposes 3 MCP resources (`manifest://leases/active`, `manifest://leases/recent`, `manifest://providers`) and 3 prompts (`deploy-containerized-app`, `diagnose-failing-app`, `shutdown-all-leases`).

## Usage

### As an MCP server (via node package)

See [`packages/node/README.md`](https://github.com/manifest-network/manifest-mcp-mono/blob/main/packages/node/README.md) for CLI usage and MCP client integration.

Set `MANIFEST_FRED_COMPATIBILITY` to `v0.13`, `pr240`, or a JSON provider API URL map such as `'{"https://upgraded-provider.example":"pr240"}'`. Unlisted providers remain on v0.13. An explicit `FredMCPServer({ fredCompatibility, ... })` option overrides the environment. This is operator configuration; mutation tools do not choose their protocol. The local devnet's separate `FRED_COMPATIBILITY` setting defaults to PR240.

### As a library

```typescript
// Use the MCP server class — Node-only, from the `/server` subpath (NOT the barrel;
// the barrel stays browser-bundleable, see ENG-287)
import { FredMCPServer } from '@manifest-network/manifest-mcp-fred/server';

const server = new FredMCPServer({
  config,          // ManifestMCPConfig from core
  walletProvider,  // WalletProvider from core
  fredCompatibility: { 'https://upgraded-provider.example': 'pr240' },
});

// Or use individual tool functions and HTTP clients directly (browser-safe barrel)
import { deployApp, browseCatalog } from '@manifest-network/manifest-mcp-fred';
import { createAuthToken } from '@manifest-network/manifest-mcp-fred';
```

`createFredClient` and `FredAuthCtx` accept the same `fredCompatibility` global mode or URL map. Deploy/restart/update call options accept a per-call mode override. Configure PR240 only for providers implementing that contract; Fred has no reliable capability endpoint for automatic negotiation.

`validateManifest(value, compatibility?)` and `buildManifestPreview(input, compatibility?)` default to v0.13. PR240 mode adds its stricter Compose/Unicode reserved-label and user-syntax checks. Deploy/update validate with the resolved provider policy before mutation. MCP previews use a configured global mode, or v0.13 when using a provider map; final deployment validation remains authoritative. Generated schema artifacts stay pinned to PR240 for drift checks.

> **SSRF guard.** When run as an MCP server, all provider/Fred HTTP is routed through core's SSRF-guarded fetch by default. Toggle it with `MANIFEST_FRED_FETCH_GUARDED` (default on; set `0`/`false`/`no`/`off` to disable — only in trusted local setups).

### HTTP clients

The package contains three HTTP client modules:

- **`http/auth.ts`** -- ADR-036 token construction. Pure functions that build sign messages and assemble base64 bearer tokens. No network calls.
- **`http/provider.ts`** -- Provider API client: `uploadLeaseData()`, `getLeaseConnectionInfo()`, `getProviderHealth()`, plus `validateProviderUrl()` / `isUrlSsrfSafe()`. Provider URLs (from untrusted on-chain records) are SSRF-classified by default: HTTPS required, and literal private/internal/loopback/metadata IPs are rejected (ENG-490). Loopback is opt-in via `{ allowLoopback }` — the fred server enables it only when `MANIFEST_FRED_FETCH_GUARDED=0`. JSON reads are byte/time bounded and runtime-schema-validated before returning.
- **`http/fred.ts`** -- Fred API client: `getLeaseStatus()`, `getLeaseLogs()`, `getLeaseProvision()`, `restartLease()`, `updateLease()`, `restoreLease()`, `getLeaseReleases()`, and `pollLeaseUntilReady()`. Endpoint schemas validate known fields while preserving unknown additions from newer providers. Raw restart/update accept `idempotencyKey` after `allowLoopback`, followed by `fredCompatibility` (default `'v0.13'`); pass both a key and `'pr240'` for intentional command replay.

Provider HTTP redirects are refused, including same-origin redirects. Configure the canonical API URL: the client never forwards a manifest body or credentials to a redirected destination. This policy applies in browsers and Node and remains active when a custom `fetch` is injected; the injected function must honor `RequestInit.redirect`. Redirect errors have `ProviderApiError.kind === 'redirect'` and are not transient.

## Build

```bash
npm run build    # tsdown (platform: neutral)
npm run lint     # tsc --noEmit
npm run test     # vitest
```

## License

MIT
