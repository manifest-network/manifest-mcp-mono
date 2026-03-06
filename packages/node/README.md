# @manifest-network/manifest-mcp-node

Node.js CLI entry points for the Manifest MCP servers with stdio transport and encrypted keyfile wallet.

Provides two binaries:
- **`manifest-mcp-chain`** — Chain MCP server (5 tools: queries, transactions, module discovery)
- **`manifest-mcp-cloud`** — Cloud MCP server (10 tools: app lifecycle, billing, monitoring)

## Setup

```bash
# From the monorepo root
npm install
npm run build
```

## Wallet setup

Both servers need a wallet to sign transactions. Choose one of the options below.

### Option A — Generate a new keyfile (recommended)

```bash
npx manifest-mcp-chain keygen   # or: npx manifest-mcp-cloud keygen
```

Both CLIs share the same keyfile (`~/.manifest/key.json`), so either command works. You will be prompted for an encryption password. The keyfile is written with mode `0600`.

### Option B — Import an existing mnemonic

```bash
npx manifest-mcp-chain import   # or: npx manifest-mcp-cloud import
```

You will be prompted for your mnemonic (any valid BIP-39 length: 12, 15, 18, 21, or 24 words) and an encryption password. The wallet is derived from the mnemonic, encrypted, and stored in the same keyfile location. The raw mnemonic is not retained.

### Option C — Mnemonic via environment variable (fallback)

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

manifest-mcp-cloud                Start the cloud MCP server (stdio)
manifest-mcp-cloud keygen         Generate a new encrypted keyfile
manifest-mcp-cloud import         Import a mnemonic into an encrypted keyfile
```

## MCP client integration

### Claude Desktop

Add the following to your `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "manifest-chain": {
      "command": "npx",
      "args": ["manifest-mcp-chain"],
      "env": {
        "COSMOS_CHAIN_ID": "manifest-ledger-beta",
        "COSMOS_RPC_URL": "https://nodes.chandrastation.com/rpc/manifest/",
        "COSMOS_GAS_PRICE": "0.01umfx",
        "MANIFEST_KEY_PASSWORD": "your-keyfile-password"
      }
    },
    "manifest-cloud": {
      "command": "npx",
      "args": ["manifest-mcp-cloud"],
      "env": {
        "COSMOS_CHAIN_ID": "manifest-ledger-beta",
        "COSMOS_RPC_URL": "https://nodes.chandrastation.com/rpc/manifest/",
        "COSMOS_GAS_PRICE": "0.01umfx",
        "MANIFEST_KEY_PASSWORD": "your-keyfile-password"
      }
    }
  }
}
```

If you use a mnemonic instead of a keyfile, replace `MANIFEST_KEY_PASSWORD` with `COSMOS_MNEMONIC`.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COSMOS_CHAIN_ID` | Yes | — | Chain ID (e.g. `manifest-ledger-beta`) |
| `COSMOS_RPC_URL` | Yes | — | RPC endpoint URL (HTTPS required; HTTP allowed for localhost) |
| `COSMOS_GAS_PRICE` | Yes | — | Gas price with denom (e.g. `0.01umfx`) |
| `COSMOS_ADDRESS_PREFIX` | No | `manifest` | Bech32 address prefix |
| `MANIFEST_KEY_FILE` | No | `~/.manifest/key.json` | Path to the encrypted keyfile |
| `MANIFEST_KEY_PASSWORD` | No | — | Password to decrypt the keyfile |
| `COSMOS_MNEMONIC` | No | — | BIP-39 mnemonic (fallback when no keyfile exists) |

`COSMOS_CHAIN_ID`, `COSMOS_RPC_URL`, and `COSMOS_GAS_PRICE` are only required when starting an MCP server, not for `keygen` or `import`.

## Chain server tools (5)

| Tool | Description |
|------|-------------|
| `get_account_info` | Get account address for the configured key |
| `cosmos_query` | Execute any Cosmos SDK query command |
| `cosmos_tx` | Execute any Cosmos SDK transaction |
| `list_modules` | List all available query and transaction modules |
| `list_module_subcommands` | List available subcommands for a specific module |

## Cloud server tools (10)

| Tool | Description |
|------|-------------|
| `browse_catalog` | Browse available cloud providers and service tiers |
| `get_balance` | Get account balances, credit status, and spending estimates |
| `fund_credits` | Fund the credit account for deploying apps |
| `list_apps` | List all leases for the current account |
| `app_status` | Get detailed status for a deployed app by lease UUID |
| `get_logs` | Get logs for a deployed app by lease UUID |
| `deploy_app` | Deploy a new application |
| `stop_app` | Stop a deployed app by closing its lease on-chain |
| `restart_app` | Restart a deployed app via the provider |
| `update_app` | Update a deployed app with a new manifest |

## License

MIT
