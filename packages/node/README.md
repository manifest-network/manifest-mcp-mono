# @manifest-network/manifest-mcp-node

Node.js CLI entry points for the Manifest MCP servers with stdio transport and encrypted keyfile wallet.

Provides four binaries:
- **`manifest-mcp-chain`** -- Chain MCP server (6 tools, +1 optional `request_faucet`: queries, transactions, fee estimation, module discovery)
- **`manifest-mcp-lease`** -- Lease MCP server (8 tools: credit balance, funding, lease queries, custom-domain claim/lookup, SKUs, providers)
- **`manifest-mcp-fred`** -- Fred MCP server (11 tools, plus 3 resources & 3 prompts: catalog, deployment readiness, manifest preview, deployment, ready polling, status, logs, restart, update, diagnostics, releases)
- **`manifest-mcp-cosmwasm`** -- CosmWasm MCP server (2 tools: MFX-to-PWR rate query, token conversion)

## Setup

```bash
# From the monorepo root
npm install
npm run build
```

## Wallet setup

All four servers need a wallet to sign transactions. Choose one of the options below.

### Option A -- Generate a new keyfile (recommended)

```bash
npx manifest-mcp-chain keygen
```

All CLIs share the same keyfile (`~/.manifest/key.json`), so any of the four commands works for `keygen` and `import`. You will be prompted for an encryption password. The keyfile is written with mode `0600`.

### Option B -- Import an existing mnemonic

```bash
npx manifest-mcp-chain import
```

You will be prompted for your mnemonic (any valid BIP-39 length: 12, 15, 18, 21, or 24 words) and an encryption password. The wallet is derived from the mnemonic, encrypted, and stored in the same keyfile location. The raw mnemonic is not retained.

### Option C -- Mnemonic via environment variable (fallback)

Set `COSMOS_MNEMONIC` in your `.env` or shell environment. This is used only when no keyfile exists.

### Wallet resolution order

1. If the keyfile exists at the path specified by `MANIFEST_KEY_FILE` (default `~/.manifest/key.json`), use it
2. Otherwise, if `COSMOS_MNEMONIC` is set, use it
3. Exit with an error if neither is available

## CLI reference

```
manifest-mcp-chain                Start the chain MCP server (stdio)
manifest-mcp-chain keygen         Generate a new encrypted keyfile
manifest-mcp-chain import         Import a mnemonic into an encrypted keyfile

manifest-mcp-lease                Start the lease MCP server (stdio)
manifest-mcp-lease keygen         Generate a new encrypted keyfile
manifest-mcp-lease import         Import a mnemonic into an encrypted keyfile

manifest-mcp-fred                 Start the fred MCP server (stdio)
manifest-mcp-fred keygen          Generate a new encrypted keyfile
manifest-mcp-fred import          Import a mnemonic into an encrypted keyfile

manifest-mcp-cosmwasm             Start the cosmwasm MCP server (stdio)
manifest-mcp-cosmwasm keygen      Generate a new encrypted keyfile
manifest-mcp-cosmwasm import      Import a mnemonic into an encrypted keyfile
```

## MCP client integration

### Claude Desktop

Add the following to your `claude_desktop_config.json`:

Replace the placeholder values below with your actual chain ID, RPC/REST endpoint, gas price, and keyfile password.

```jsonc
{
  "mcpServers": {
    "manifest-chain": {
      "command": "npx",
      "args": ["manifest-mcp-chain"],
      "env": {
        "COSMOS_CHAIN_ID": "your-chain-id",
        "COSMOS_RPC_URL": "https://your-rpc-endpoint/",
        "COSMOS_GAS_PRICE": "0.01umfx",
        "MANIFEST_KEY_PASSWORD": "your-keyfile-password"
      }
    },
    "manifest-lease": {
      "command": "npx",
      "args": ["manifest-mcp-lease"],
      "env": {
        "COSMOS_CHAIN_ID": "your-chain-id",
        "COSMOS_RPC_URL": "https://your-rpc-endpoint/",
        "COSMOS_GAS_PRICE": "0.01umfx",
        "MANIFEST_KEY_PASSWORD": "your-keyfile-password"
      }
    },
    "manifest-fred": {
      "command": "npx",
      "args": ["manifest-mcp-fred"],
      "env": {
        "COSMOS_CHAIN_ID": "your-chain-id",
        "COSMOS_RPC_URL": "https://your-rpc-endpoint/",
        "COSMOS_GAS_PRICE": "0.01umfx",
        "MANIFEST_KEY_PASSWORD": "your-keyfile-password"
      }
    },
    "manifest-cosmwasm": {
      "command": "npx",
      "args": ["manifest-mcp-cosmwasm"],
      "env": {
        "COSMOS_CHAIN_ID": "your-chain-id",
        "COSMOS_RPC_URL": "https://your-rpc-endpoint/",
        "COSMOS_GAS_PRICE": "0.01umfx",
        "MANIFEST_KEY_PASSWORD": "your-keyfile-password",
        "MANIFEST_CONVERTER_ADDRESS": "manifest1..."
      }
    }
  }
}
```

If you use a mnemonic instead of a keyfile, replace `MANIFEST_KEY_PASSWORD` with `COSMOS_MNEMONIC`.

#### Query-only mode (REST/LCD)

To use query-only mode without transaction signing, replace `COSMOS_RPC_URL` and `COSMOS_GAS_PRICE` with `COSMOS_REST_URL`:

```jsonc
{
  "mcpServers": {
    "manifest-chain": {
      "command": "npx",
      "args": ["manifest-mcp-chain"],
      "env": {
        "COSMOS_CHAIN_ID": "your-chain-id",
        "COSMOS_REST_URL": "https://your-rest-endpoint/",
        "MANIFEST_KEY_PASSWORD": "your-keyfile-password"
      }
    }
  }
}
```

A wallet is still required at startup even in query-only mode. Transaction tools will return an `INVALID_CONFIG` error.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COSMOS_CHAIN_ID` | Yes | -- | Chain ID (e.g. `manifest-ledger-beta`) |
| `COSMOS_RPC_URL` | One of `COSMOS_RPC_URL` or `COSMOS_REST_URL` required | -- | RPC endpoint URL (HTTPS required; HTTP allowed for localhost) |
| `COSMOS_GAS_PRICE` | Required when `COSMOS_RPC_URL` is set | -- | Gas price with denom (e.g. `0.01umfx`) |
| `COSMOS_REST_URL` | One of `COSMOS_RPC_URL` or `COSMOS_REST_URL` required | -- | LCD/REST endpoint URL for query-only mode |
| `COSMOS_GAS_MULTIPLIER` | No | `1.5` | Gas simulation multiplier (must be >= 1) |
| `COSMOS_ADDRESS_PREFIX` | No | `manifest` | Bech32 address prefix |
| `MANIFEST_KEY_FILE` | No | `~/.manifest/key.json` | Path to the encrypted keyfile |
| `MANIFEST_KEY_PASSWORD` | No | -- | Password to decrypt the keyfile |
| `COSMOS_MNEMONIC` | No | -- | BIP-39 mnemonic (fallback when no keyfile exists) |
| `MANIFEST_FAUCET_URL` | No | -- | Faucet URL (enables `request_faucet` tool on chain server) |
| `MANIFEST_CONVERTER_ADDRESS` | Required for cosmwasm server | -- | CosmWasm converter contract address |
| `LOG_LEVEL` | No | `warn` | Log level: `debug`, `info`, `warn`, `error`, or `silent` |

Set `COSMOS_RPC_URL` + `COSMOS_GAS_PRICE` for full access (queries + transactions). Set `COSMOS_REST_URL` alone for query-only mode (LCD/REST). When both are set, `COSMOS_REST_URL` is preferred for queries.

`COSMOS_CHAIN_ID` and at least one endpoint URL are only required when starting an MCP server, not for `keygen` or `import`.

## Chain server tools (6, +1 optional)

| Tool | Description |
|------|-------------|
| `get_account_info` | Get account address for the configured key |
| `cosmos_query` | Execute any Cosmos SDK query command |
| `cosmos_tx` | Execute any Cosmos SDK transaction |
| `cosmos_estimate_fee` | Estimate gas + fee for a transaction without broadcasting |
| `list_modules` | List all available query and transaction modules |
| `list_module_subcommands` | List available subcommands for a specific module |
| `request_faucet` | Request tokens from a faucet (registered only when `MANIFEST_FAUCET_URL` is set) |

## Lease server tools (8)

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

## Fred server tools (11)

| Tool | Description |
|------|-------------|
| `browse_catalog` | Browse available providers and service tiers with health checks |
| `check_deployment_readiness` | Pre-flight checks (balance, SKU availability, image pull) before `deploy_app` |
| `build_manifest_preview` | Preview the SDL/manifest that `deploy_app` would submit |
| `deploy_app` | Deploy a new application (create lease + deploy container, optional custom domain) |
| `wait_for_app_ready` | Poll provider until a deployed app reports ready |
| `app_status` | Get detailed status for a deployed app by lease UUID |
| `get_logs` | Get logs for a deployed app by lease UUID |
| `restart_app` | Restart a deployed app via the provider |
| `update_app` | Update a deployed app with a new manifest |
| `app_diagnostics` | Get provision diagnostics for a deployed app |
| `app_releases` | Get release/version history for a deployed app |

The Fred server also exposes 3 MCP resources (`manifest://leases/active`, `manifest://leases/recent`, `manifest://providers`) and 3 prompts (`deploy-containerized-app`, `diagnose-failing-app`, `shutdown-all-leases`).

## CosmWasm server tools (2)

| Tool | Description |
|------|-------------|
| `get_mfx_to_pwr_rate` | Get the current MFX-to-PWR conversion rate and preview amounts |
| `convert_mfx_to_pwr` | Convert MFX tokens to PWR via the on-chain converter contract |

## See also

The links below resolve from the GitHub repo. They use absolute URLs because the published npm package only ships `dist/` and the `docs/` tree isn't included, so relative paths would 404 on npmjs.com.

- [Tool selection guide](https://github.com/manifest-network/manifest-mcp-mono/blob/main/docs/tool-selection-guide.md) — which server to wire up and which tool to call
- [Usage examples](https://github.com/manifest-network/manifest-mcp-mono/blob/main/docs/usage-examples.md) — end-to-end transcripts (balances, deploys, diagnostics, conversions)
- [Prompts and resources](https://github.com/manifest-network/manifest-mcp-mono/blob/main/docs/prompts-and-resources.md) — what the Fred server's 3 prompts and 3 resources expose
- [Troubleshooting](https://github.com/manifest-network/manifest-mcp-mono/blob/main/docs/troubleshooting.md) — error codes, common failure modes, and how to recover
- [Security model](https://github.com/manifest-network/manifest-mcp-mono/blob/main/docs/security.md) — wallet handling, ADR-036 auth, output redaction, trust boundaries
- [Library usage](https://github.com/manifest-network/manifest-mcp-mono/blob/main/docs/library-usage.md) — using the packages outside an MCP host

## License

MIT
