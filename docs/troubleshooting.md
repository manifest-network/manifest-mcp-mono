# Troubleshooting

Diagnostics for the most common failure modes when running an MCP server, broken down by symptom.

## Server won't start

### `Environment variable COSMOS_CHAIN_ID is not set`

The CLI couldn't load required configuration. Make sure your `.env` file is in the working directory the host launches the server from, or pass the variables through the host's `env` block (Claude Desktop's `claude_desktop_config.json` is the usual place).

### `At least one of COSMOS_RPC_URL or COSMOS_REST_URL must be set`

Pick one:
- `COSMOS_RPC_URL` + `COSMOS_GAS_PRICE` — full access (queries + transactions).
- `COSMOS_REST_URL` alone — query-only mode. `cosmos_tx`, `fund_credit`, `close_lease`, `deploy_app`, `convert_mfx_to_pwr`, etc. will raise `INVALID_CONFIG` at call time.

### `COSMOS_GAS_PRICE is required when COSMOS_RPC_URL is set`

Add `COSMOS_GAS_PRICE=0.01umfx` (or whatever the chain's minimum is) to your `.env`. The fee denom must be one the validators accept; check the chain config or use `cosmos_query bank denoms-metadata` once a query-only mode is up.

### `Invalid MANIFEST_FAUCET_URL: MANIFEST_FAUCET_URL must use HTTPS (got http://)…`

Same SSRF guard the chain RPC and REST URLs use. HTTPS required, except for `localhost` / `127.0.0.1` / `::1`. Either fix the URL or run a local faucet. The chain CLI wraps the validator's reason in an `Invalid MANIFEST_FAUCET_URL:` prefix before exiting.

### `MANIFEST_CONVERTER_ADDRESS environment variable is required`

Cosmwasm server only. Set it to the bech32 address of the MFX→PWR converter contract. Without it, the server refuses to start.

### `No wallet found. Either: 1. Run "manifest-mcp-chain keygen" … 2. Set COSMOS_MNEMONIC`

Wallet resolution order is keyfile (`MANIFEST_KEY_FILE`, default `~/.manifest/key.json`) → mnemonic env var (`COSMOS_MNEMONIC`) → fail. Generate or import a key via `npx manifest-mcp-chain keygen` / `import` (any of the five CLIs works — they all share the same keyfile).

### `Failed to decrypt keyfile at <path>. Verify that MANIFEST_KEY_PASSWORD is correct.`

The password in `MANIFEST_KEY_PASSWORD` doesn't match the keyfile. The decrypt path checks before the server starts so an MCP host never silently gets a wallet-less process.

## Errors at tool call time

Most errors returned to the MCP client are JSON objects with a `code` field drawn from `ManifestMCPErrorCode`. (An error raised outside the Manifest error path — e.g. a `ProviderApiError` from a provider HTTP call — reaches the client without a `ManifestMCPErrorCode` and is logged as `UNKNOWN`.) The 15 codes group into 8 categories:

| Category | Codes | Meaning |
|----------|-------|---------|
| Configuration | `INVALID_CONFIG` | Missing/invalid env, query-only mode invoked for a tx, malformed input that's a static rule violation |
| Wallet | `WALLET_NOT_CONNECTED`, `WALLET_CONNECTION_FAILED`, `INVALID_MNEMONIC` | Wallet bootstrap failed or a wallet operation was attempted post-disconnect |
| Client / RPC | `RPC_CONNECTION_FAILED` | Couldn't reach the configured `rpcUrl` / `restUrl` |
| Query | `QUERY_FAILED`, `UNSUPPORTED_QUERY`, `INVALID_ADDRESS`, `INVALID_ARGUMENT` | Chain-side rejection of a read, unsupported subcommand, malformed bech32, or a malformed argument (non-UUID id, bad FQDN) |
| Transaction | `TX_FAILED`, `UNSUPPORTED_TX`, `SIMULATION_FAILED` | Chain-side rejection of a write, unsupported subcommand, simulation step failed |
| Module | `UNKNOWN_MODULE` | Module name not in the registry |
| User action | `OPERATION_CANCELLED` | A deliberate user decline / cancel / elicitation-timeout — treated as neither a fault nor retryable |
| SKU resolution | `SKU_AMBIGUOUS` | A SKU `size`/`storage` name matched more than one active SKU; `details` carries `{ reason: 'AMBIGUOUS_SKU_NAME', size, candidates }` — disambiguate with `provider_uuid` / `sku_uuid` |

### `INVALID_CONFIG` from a transaction tool

Either the server was started in query-only mode (no `COSMOS_RPC_URL` / `COSMOS_GAS_PRICE`) or your input violated a static rule. The error `details.errors` array enumerates the issues.

### `RPC_CONNECTION_FAILED`

The configured endpoint isn't reachable. Verify the URL, that it's HTTPS-or-localhost, and that the chain is up. Transient connection errors are auto-retried with exponential backoff (3 retries, base 1s, max 10s); a sustained failure surfaces this code.

### `QUERY_FAILED` / `TX_FAILED`

The chain answered "no". `error.details` usually carries the chain's raw error string. Common causes:
- Insufficient balance.
- Sequence mismatch (rare; usually caused by another process broadcasting from the same wallet).
- A governance/billing rule that rejected the message.

### `SIMULATION_FAILED`

The transaction couldn't even be simulated (so it was never broadcast). Often an out-of-gas or message-validation failure. Try `cosmos_estimate_fee` with the same inputs to surface the chain's exact reason.

### `UNSUPPORTED_QUERY` / `UNSUPPORTED_TX`

The (module, subcommand) pair isn't in the registry. The error `details.availableSubcommands` lists what's valid for that module. Use `list_module_subcommands` to discover the surface for a given module.

### `UNSUPPORTED_QUERY` specifically from `cosmos.orm.*` or `liftedinit.manifest.*` in REST mode

The LCD adapter returns proxy objects for these two namespaces because manifestjs doesn't expose them over LCD. Switch to RPC mode (`COSMOS_RPC_URL`) for those queries.

### `INVALID_ADDRESS`

Bech32 prefix doesn't match `COSMOS_ADDRESS_PREFIX` (default `manifest`), or the address is malformed. Common when a tutorial uses `cosmos1…` against a chain configured for `manifest1…`.

## Deploy partial-success errors

If `deploy_app` creates the lease but fails on a later step (custom domain claim, manifest upload, ready polling), it returns an error with the live `lease_uuid`, `provider_uuid`, and `provider_url`. The lease still exists and you're paying for it. Either:

- Retry the failing step (often the upload — providers can be transiently unhealthy), or
- Close the orphaned lease with `close_lease({ lease_uuid })`.

The error message starts with `Deploy partially succeeded:` so an agent can branch on the prefix.

## App is stuck in `LEASE_STATE_PENDING`

Check the provider:

1. `app_diagnostics({ lease_uuid })` — `provision_status`, `fail_count`, `last_error`.
2. `get_logs({ lease_uuid, tail: 200 })` — container output (will be empty if the image hasn't pulled yet).
3. `app_status({ lease_uuid })` — chain state vs provider state may differ when something failed during provisioning.

Common causes:
- Image registry is allowlisted differently than you expected (the `allowed_registries` list isn't on-chain — it's provider config, only checked at upload time).
- Image is private and the provider doesn't have credentials.
- Tags don't exist (e.g. `myapp:lates` typo).
- Resource limits in the SKU don't fit the container (rare; usually surfaces as `last_error`).

## Auth token rejected by the provider

The provider enforces a 30-second max token age and 10-second max-future skew. If your machine clock drifts (especially in containers with a stale clock at startup), token construction will succeed but the provider will reject. Sync NTP. Replay attacks within the 30-second window are rejected by signature deduplication; the `AuthTimestampTracker` makes sure two consecutive calls don't share a timestamp.

## `SSRF blocked: … resolves to … which is in blocked range 'loopback'`

The provider/Fred fetch guard (`MANIFEST_FRED_FETCH_GUARDED`, on by default) resolves the target host at connect time and blocks any non-`unicast` IP. A provider or lease URL that passes the HTTPS-or-localhost scheme check but points at `localhost` / `127.0.0.1` / `::1` — common in local development against a provider on your own machine — is allowed by the URL validator but then **blocked at connect time** by the guard, surfacing as `SSRF blocked: <host> resolves to <ip> which is in blocked range 'loopback' (…)`.

To reach a localhost provider in development, disable the guard: `MANIFEST_FRED_FETCH_GUARDED=0` (fred) or `MANIFEST_AGENT_FETCH_GUARDED=0` (agent). Only do this in trusted local setups — the guard is what stops a malicious on-chain provider URL from reaching your internal network.

## "Tool returned a structured response that doesn't match its outputSchema"

This came up during the v0.7.0 rollout — `app_diagnostics` declared `last_error` as required when the provider can omit it. If you see something similar now, file an issue with the tool name and the response payload; the schemas are pinned by tests and shouldn't drift silently.

## Logs aren't showing up

`LOG_LEVEL` defaults to `warn`. Set `LOG_LEVEL=debug` (or `info`) in your environment to see the per-request lines. **All output goes to stderr** — stdout is reserved for the MCP JSON-RPC protocol. In Claude Desktop, server stderr appears in `~/Library/Logs/Claude/mcp-server-<name>.log` (macOS) or the equivalent path on your platform.

## E2E suite fails locally

The Compose stack expects healthy submodules and a recent Docker:

```bash
git submodule update --init --recursive
docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180
npm run test:e2e
docker compose -f e2e/docker-compose.yml down -v --remove-orphans
```

If the chain container fails to boot, `docker compose -f e2e/docker-compose.yml logs chain` is the first place to look. The chain image is built from `submodules/manifest-ledger` at the pinned commit; if that submodule is dirty or behind, the chain won't have the right protobuf surface for manifestjs.

## Still stuck

Open an issue at <https://github.com/manifest-network/manifest-mcp-mono/issues> with the error code, the redacted error JSON, and `LOG_LEVEL=debug` server output. Do not paste raw mnemonics, keyfile contents, or `MANIFEST_KEY_PASSWORD`.
