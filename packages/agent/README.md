# @manifest-network/manifest-mcp-agent

MCP server wrapping [`@manifest-network/manifest-agent-core`](../agent-core/README.md) orchestration (deploy / manage-domain / lookup-domain / troubleshoot / close-lease) via MCP **elicitation**. The three broadcasting tools translate agent-core's typed confirmation callbacks (`onConfirm`, plus `onPlan` for `deploy_app_orchestrated`) into standard MCP `elicitation/create` requests so any elicitation-capable host (Claude Code ≥ 2.1.76; the MCP elicitation capability was standardized in the 2025-06-18 spec revision) can drive the confirm flow over wire — no `AskUserQuestion`, no interactive stdin, no out-of-band channel. The read-only tools (lookup / troubleshoot) perform no elicitation — they emit only progress and failure/log notifications (`notifications/progress` + `notifications/message`) and run on any host.

## Installation

```bash
npm install @manifest-network/manifest-mcp-agent
```

## Tools

| Tool | agent-core function | Description |
| ---- | ------------------- | ----------- |
| `deploy_app_orchestrated` | `deployApp` | Plan → confirm → broadcast (fred atomic deploy: create-lease + manifest upload + optional set-domain) → persist manifest. Bidirectional recovery on partial-success via `onFailure(env, options)` → enum-of-`RecoveryOptionId` elicitation. |
| `manage_domain_orchestrated` | `manageDomain` | `set` / `clear` a lease item's custom domain. Confirm → broadcast → verify on-chain. |
| `lookup_custom_domain_orchestrated` | `manageDomain` (lookup) | Reverse-resolve an FQDN to its owning lease. Pure chain query — no broadcast, zero elicitations. Returns the lease or `null` when unclaimed. |
| `troubleshoot_deployment_orchestrated` | `troubleshootDeployment` | Markdown-formatted chain-side diagnostic report. No broadcast. |
| `close_lease_orchestrated` | `closeLease` | Confirm → broadcast close-lease → verify terminal state on-chain. Permanent. |

Each tool returns the corresponding agent-core result type (`DeployResult` / `ManageDomainResult` / `TroubleshootReport` / `CloseLeaseResult`) as structured content. Errors surface as the standard MCP error envelope; `ManifestMCPError` subtypes pass through unchanged via `withErrorHandling`.

## Host requirements

MCP elicitation support is required **only for the tools/actions that prompt the user**: `deploy_app_orchestrated`, `close_lease_orchestrated`, and `manage_domain_orchestrated` with `action='set'` or `'clear'`. Hosts that don't advertise `capabilities.elicitation` at `initialize` receive `ManifestMCPError(INVALID_CONFIG)` with a clear diagnostic when invoking those paths — the wrapper does not fall back to stdin prompts or auto-confirm.

The two read-only paths run **without** an elicitation-capable host:
- `troubleshoot_deployment_orchestrated` — pure chain-side diagnostic report
- `lookup_custom_domain_orchestrated` — pure chain query reverse-resolving an FQDN to its owning lease

Verified hosts:
- Claude Code ≥ 2.1.76 (full surface; elicitation-capable)
- Any MCP host (read-only surface: troubleshoot + lookup_custom_domain)

## Environment variables

The agent server reads the standard chain / wallet env vars (same matrix as `manifest-mcp-chain` / `manifest-mcp-lease` / `manifest-mcp-fred`) plus four agent-only additions.

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `COSMOS_CHAIN_ID` | Yes | — | Active-chain detection (`testnet` / `mainnet`) inside `deployApp` reads this. |
| `COSMOS_RPC_URL` + `COSMOS_GAS_PRICE` | One of RPC/REST | — | RPC required for broadcast operations (deploy / manage / close). |
| `COSMOS_REST_URL` | One of RPC/REST | — | When both are set, REST is preferred for queries. |
| `COSMOS_GAS_MULTIPLIER` | No | `1.5` | Must be ≥ 1. |
| `COSMOS_MAX_GAS` | No | `50000000` | Absolute per-tx gas ceiling; a broadcast aborts with `GAS_LIMIT_EXCEEDED` when `ceil(simulate × multiplier)` exceeds it; `-1` disables. Enforced on deploy / manage-domain / close-lease. |
| `COSMOS_ADDRESS_PREFIX` | No | `manifest` | |
| `MANIFEST_KEY_FILE` | No | `~/.manifest/key.json` | Encrypted keyfile path. |
| `MANIFEST_KEY_PASSWORD` | No | — | Keyfile decrypt password. |
| `COSMOS_MNEMONIC` | No | — | Fallback wallet (no keyfile). |
| `MANIFEST_AGENT_DATA_DIR` | No | — | Passes to `DeployAppOptions.dataDir` (operator-set; the `deploy_app_orchestrated` tool no longer accepts a per-call `data_dir` override). When unset, manifest persistence is skipped and success still emits. Pass a dedicated subdirectory (NOT `$HOME` or any shared dir) — `saveManifest()` `chmod`s this path to `0o700`. |
| `MANIFEST_CHAIN_DATA_FILE` | No | — | Path to a chain-registry JSON (`{ feeTokens: [...] }`) for denom humanization (e.g. `umfx` → `MFX`). Loaded once (lazily, on first tool call) and cached. |
| `MANIFEST_AGENT_FETCH_GUARDED` | No | `1` (default ON) | Swaps in agent-core's SSRF-guarded `createGuardedFetch` (Node-only — dynamic import keeps the platform-neutral build legal). Set to `0` / `false` / `no` / `off` to disable (e.g. for local-loopback testing). Accepted truthy: `1` / `true` / `yes` / `on`; case-insensitive. Unrecognized values throw `INVALID_CONFIG` rather than silently no-op. |
| `MANIFEST_AGENT_ELICIT_TIMEOUT_MS` | No | `600000` (10 min) | Per-`elicitInput` timeout in milliseconds. The MCP SDK default of 60s is far too short for a human reading a deployment-plan recap — so this server defaults to 10 minutes. Positive integer; malformed values fall back to the default. |
| `LOG_LEVEL` | No | `warn` | `debug` / `info` / `warn` / `error` / `silent`. |

## CLI usage

Distributed as a single binary `manifest-mcp-agent` via the [`@manifest-network/manifest-mcp-node`](../node/README.md) package:

```bash
COSMOS_CHAIN_ID=manifest-2 \
COSMOS_RPC_URL=https://nodes.liftedinit.tech:443 \
COSMOS_GAS_PRICE=0.025umfx \
MANIFEST_KEY_FILE=~/.manifest/key.json \
MANIFEST_KEY_PASSWORD=... \
manifest-mcp-agent
```

## MCP-client config

Minimal `claude_desktop_config.json` (equivalent for any elicitation-capable MCP host):

```jsonc
{
  "mcpServers": {
    "manifest-agent": {
      "command": "manifest-mcp-agent",
      "env": {
        "COSMOS_CHAIN_ID": "manifest-2",
        "COSMOS_RPC_URL": "https://nodes.liftedinit.tech:443",
        "COSMOS_GAS_PRICE": "0.025umfx",
        "MANIFEST_KEY_FILE": "~/.manifest/key.json",
        "MANIFEST_KEY_PASSWORD": "...",
        "MANIFEST_AGENT_DATA_DIR": "~/.manifest/manifests",
        "MANIFEST_CHAIN_DATA_FILE": "~/.manifest/chain.json"
      }
    }
  }
}
```

## Library usage

```typescript
import { AgentMCPServer } from '@manifest-network/manifest-mcp-agent';

const server = new AgentMCPServer({
  config,          // ManifestMCPConfig from @manifest-network/manifest-mcp-core
  walletProvider,  // WalletProvider from @manifest-network/manifest-mcp-core
});
const mcpServer = server.getServer();
// Connect mcpServer to your preferred MCP transport.
```

### Dependency injection (testing)

Tests can override any of the four agent-core orchestration functions via the constructor's `orchestrators` option:

```typescript
const server = new AgentMCPServer({
  config,
  walletProvider,
  orchestrators: {
    deployApp: async (spec, callbacks, opts) => {
      callbacks.onProgress?.({ kind: 'user_confirmed' });
      return { /* fake DeployResult */ };
    },
  },
});
```

Missing keys fall back to the real implementations. Production callers leave `orchestrators` undefined.

## Build

```bash
npm run build    # tsdown (platform: neutral)
npm run lint     # tsc --noEmit
npm run test     # vitest
```

## Architecture notes

The wrapper is **pure adapter** — no orchestration logic, no re-rendering of the human-prose blocks that agent-core's `internals/render-*.ts` modules produce. All elicitation `message` bodies are passed through verbatim. See [`../agent-core/README.md`](../agent-core/README.md) for the callback contract and [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the full callback → elicitation translation and the downstream `_meta.manifest` matrix consumed by the manifest-agent plugin's PreToolUse hook.

## License

MIT
