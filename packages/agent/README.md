# @manifest-network/manifest-mcp-agent

MCP server wrapping [`@manifest-network/manifest-agent-core`](../agent-core/README.md) orchestration (deploy / manage-domain / troubleshoot / close-lease) via MCP **elicitation**. The four tools translate agent-core's typed `onPlan` / `onConfirm` / `onProgress` / `onFailure` callbacks into standard MCP `elicitation/create` requests and `notifications/progress` events, so any elicitation-capable host (Claude Code ≥ 2.1.76; the MCP elicitation spec was finalized in 2026) can drive the bidirectional flow over wire — no `AskUserQuestion`, no interactive stdin, no out-of-band channel.

## Installation

```bash
npm install @manifest-network/manifest-mcp-agent
```

## Tools

| Tool | agent-core function | Description |
| ---- | ------------------- | ----------- |
| `deploy_app_orchestrated` | `deployApp` | Plan → confirm → broadcast (fred atomic deploy: create-lease + manifest upload + optional set-domain) → persist manifest. Bidirectional recovery on partial-success via `onFailure(env, options)` → enum-of-`RecoveryOptionId` elicitation. |
| `manage_domain_orchestrated` | `manageDomain` | `set` / `clear` / `lookup` a lease item's custom domain. `set` / `clear` confirm → broadcast → verify on-chain. `lookup` is a pure chain query. |
| `troubleshoot_deployment_orchestrated` | `troubleshootDeployment` | Markdown-formatted chain-side diagnostic report. No broadcast. |
| `close_lease_orchestrated` | `closeLease` | Confirm → broadcast close-lease → verify terminal state on-chain. Permanent. |

Each tool returns the corresponding agent-core result type (`DeployResult` / `ManageDomainResult` / `TroubleshootReport` / `CloseLeaseResult`) as structured content. Errors surface as the standard MCP error envelope; `ManifestMCPError` subtypes pass through unchanged via `withErrorHandling`.

## Host requirements

This server **requires** MCP elicitation support. Hosts that don't advertise `capabilities.elicitation` at `initialize` receive `ManifestMCPError(INVALID_CONFIG)` with a clear diagnostic — the wrapper does not fall back to stdin prompts or auto-confirm.

Verified hosts:
- Claude Code ≥ 2.1.76

## Environment variables

The agent server reads the standard chain / wallet env vars (same matrix as `manifest-mcp-chain` / `manifest-mcp-lease` / `manifest-mcp-fred`) plus three agent-only additions.

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `COSMOS_CHAIN_ID` | Yes | — | Active-chain detection (`testnet` / `mainnet`) inside `deployApp` reads this. |
| `COSMOS_RPC_URL` + `COSMOS_GAS_PRICE` | One of RPC/REST | — | RPC required for broadcast operations (deploy / manage / close). |
| `COSMOS_REST_URL` | One of RPC/REST | — | When both are set, REST is preferred for queries. |
| `COSMOS_GAS_MULTIPLIER` | No | `1.5` | Must be ≥ 1. |
| `COSMOS_ADDRESS_PREFIX` | No | `manifest` | |
| `MANIFEST_KEY_FILE` | No | `~/.manifest/key.json` | Encrypted keyfile path. |
| `MANIFEST_KEY_PASSWORD` | No | — | Keyfile decrypt password. |
| `COSMOS_MNEMONIC` | No | — | Fallback wallet (no keyfile). |
| `MANIFEST_AGENT_DATA_DIR` | No | — | Passes to `DeployAppOptions.dataDir`. When unset, manifest persistence is skipped and success still emits. Pass a dedicated subdirectory (not `$HOME`) — `saveManifest()` may tighten its permissions. |
| `MANIFEST_CHAIN_DATA_FILE` | No | — | Path to a chain-registry JSON (`{ feeTokens: [...] }`) for denom humanization (e.g. `umfx` → `MFX`). Loaded once at startup. |
| `MANIFEST_AGENT_FETCH_GUARDED` | No | `0` | When `1`, swaps in agent-core's SSRF-guarded `createGuardedFetch` (Node-only — dynamic import keeps the platform-neutral build legal). |
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

The wrapper is **pure adapter** — no orchestration logic, no re-rendering of the human-prose blocks that agent-core's `internals/render-*.ts` modules produce. All elicitation `message` bodies are passed through verbatim. See [PLAN.md §2](../../PLAN.md) for the full callback → elicitation translation contract and the downstream `_meta.manifest` matrix consumed by the manifest-agent plugin's PreToolUse hook.

## License

MIT
