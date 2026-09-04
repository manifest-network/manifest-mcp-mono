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

Wallet resolution order is keyfile (`MANIFEST_KEY_FILE`, default `~/.manifest/key.json`) → mnemonic env var (`COSMOS_MNEMONIC`) → fail. Generate or import a key via `npx -y -p @manifest-network/manifest-mcp-node manifest-mcp-chain keygen` / `import` (any of the five CLIs works — they all share the same keyfile). The bin name has to be selected out of the scoped package: `npx manifest-mcp-chain` would resolve `manifest-mcp-chain` as a *package* name, which does not exist on npm.

### `Failed to decrypt keyfile at <path>. Verify that MANIFEST_KEY_PASSWORD is correct.`

The password in `MANIFEST_KEY_PASSWORD` doesn't match the keyfile. The decrypt path checks before the server starts so an MCP host never silently gets a wallet-less process.

**If you are certain the password is right**, the keyfile may have been created by a release before ENG-668, whose hidden-input reader treated a whole stdin chunk as one keystroke. Pasting a password there appended the paste's trailing carriage return and/or newline to the secret, so the keyfile was encrypted with `yourpassword\r\n` while you believed it was `yourpassword`. The confirm prompt matched because the same paste was repeated. Try the exact bytes:

Pass the exact bytes **on the same line as the command**, so they reach the process. A bare `VAR=value` on its own line only sets a shell variable, which a subsequently launched CLI does not inherit:

```bash
# bash / zsh: $'...' is what makes \r and \n real bytes rather than literal backslashes
MANIFEST_KEY_PASSWORD=$'yourpassword\r\n' npx -y -p @manifest-network/manifest-mcp-node manifest-mcp-chain export

# if that fails, the paste may have carried only a newline
MANIFEST_KEY_PASSWORD=$'yourpassword\n' npx -y -p @manifest-network/manifest-mcp-node manifest-mcp-chain export
```

`export` takes `MANIFEST_KEY_PASSWORD` verbatim when it is set, and only prompts otherwise — deliberately, because the prompt treats CR and LF as submission and therefore *cannot* express the corrupted password. That is the one route into an affected keyfile.

Once it prints the recovery phrase, write it down, then `<cli> import` it under a password you type rather than paste. Current releases classify each character of a chunk individually, so a pasted password now produces exactly the same key as a typed one.

## Errors at tool call time

Most errors returned to the MCP client are JSON objects with a `code` field drawn from `ManifestMCPErrorCode`. (An error raised outside the Manifest error path — e.g. a `ProviderApiError` from a provider HTTP call — reaches the client without a `ManifestMCPErrorCode` and is logged as `UNKNOWN`.) The 23 codes group into 11 categories:

| Category | Codes | Meaning |
|----------|-------|---------|
| Configuration | `INVALID_CONFIG` | Missing/invalid env, query-only mode invoked for a tx, malformed input that's a static rule violation |
| Wallet | `WALLET_NOT_CONNECTED`, `WALLET_CONNECTION_FAILED`, `INVALID_MNEMONIC` | Wallet bootstrap failed or a wallet operation was attempted post-disconnect |
| Client / RPC | `RPC_CONNECTION_FAILED` | Couldn't reach the configured `rpcUrl` / `restUrl` |
| Query | `QUERY_FAILED`, `UNSUPPORTED_QUERY`, `INVALID_ADDRESS`, `INVALID_ARGUMENT`, `NOT_FOUND` | Chain-side rejection of a read, unsupported subcommand, malformed bech32, a malformed argument (non-UUID id, bad FQDN), or an expected "no such entity" absence (`NOT_FOUND` — the chain answered no such entity; non-retryable, distinct from an HTTP/route 404 which stays `QUERY_FAILED`) |
| Transaction | `TX_FAILED`, `UNSUPPORTED_TX`, `SIMULATION_FAILED`, `GAS_LIMIT_EXCEEDED` | Chain-side rejection of a write, unsupported subcommand, simulation step failed, or a pre-broadcast safety abort (`GAS_LIMIT_EXCEEDED` — either `ceil(simulate × gasMultiplier)` or an explicit `fee.gas` exceeded the `COSMOS_MAX_GAS` / `maxGas` ceiling; non-retryable) |
| Module | `UNKNOWN_MODULE` | Module name not in the registry |
| User action | `OPERATION_CANCELLED` | A deliberate user decline / cancel / elicitation-timeout, or a completed user-selected orchestration recovery — neither a fault nor retryable; inspect operation-specific `details` because side effects may have completed |
| SKU resolution | `SKU_AMBIGUOUS` | A SKU `size`/`storage` name matched more than one active SKU; `details` carries `{ reason: 'AMBIGUOUS_SKU_NAME', size, candidates }` — disambiguate with `provider_uuid` / `sku_uuid` |
| Deploy | `DEPLOY_READINESS_UNCONFIRMED` | A paid lease exists, but the client cannot safely confirm it as ready. Either the readiness poll ended without a verdict, or the canonical final provider state was absent, malformed, or not ACTIVE. Carries `details.readiness_unconfirmed`, `lease_uuid`, and `partial`; orchestration final-state disagreement additionally carries `readiness_reason: 'final_state_mismatch'`, `state_source`, and bounded `observed_state`. Diagnose the existing lease instead of repeating `deploy_app` — see below |
| Restore | `RESTORE_NOT_RETAINED`, `RESTORE_REJECTED`, `RESTORE_RETRYABLE`, `RESTORE_ORPHAN_COMPENSATION_FAILED` | `restore_app` saga outcomes: source not restorable (pre-flight, zero side effects), a terminal 4xx rejection (created lease rolled back), a transient refusal the agent may deliberately re-invoke — 503 placement or 429 throttle — (rolled back), or a compensation failure that left an orphan lease. All non-auto-retryable — restore is non-idempotent |
| Update | `UPDATE_INDETERMINATE` | `update_app` reached the provider and got a 5xx, which does **not** establish whether the manifest was applied. The provider persists the payload after the backend accepts it, so a persist failure can mean the update is live now and the next reprovision will revert it. Diagnose with `app_status` / `app_releases` before acting; re-invoking `update_app` re-applies and re-records. Non-auto-retryable — `update_app` is non-idempotent |

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

**Completed orchestrated recovery.** A successful `retry_set_domain` returns the normal deployment result. A completed `salvage_without_domain`, `cancel_lease`, or `close_lease` choice instead terminates the original deploy flow with `OPERATION_CANCELLED`, `details.lease_uuid`, and the selected `details.recovery_outcome`; this shape intentionally does not set `details.partial`. Salvage retains the live, billing lease. Cancel/close choices also report what teardown actually did in `details.stop_outcome` (`stopped`, `cancelled`, or `already_inactive`) and `details.lease_state`. `details.transaction_hash` is present exactly when `stop_outcome` is `stopped` or `cancelled`, and absent for `already_inactive` (including post-broadcast terminal reconciliation). Do not retry the deployment automatically. A genuine teardown failure surfaces its original error instead.

For unresolved failures, if `deploy_app` creates the lease but cannot complete normally, `details.partial` is `true` and `details.lease_uuid` identifies the existing paid lease. Some lower-level partial failures also include `provider_uuid` / `provider_url` and use a `Deploy partially succeeded:` message prefix, but callers should branch on structured details instead of prose. **Where confirmation stopped decides what to do — the cases below call for different responses.**

### `DEPLOY_READINESS_UNCONFIRMED` — readiness could not be safely confirmed

Every variant carries `details.readiness_unconfirmed === true`, `details.partial === true`, and `details.lease_uuid`. Do not repeat `deploy_app`: it is non-idempotent and the lease already exists. The related post-broadcast shapes are:

| Error shape | Meaning | Default response |
|-------------|---------|------------------|
| `DEPLOY_READINESS_UNCONFIRMED` + `readiness_unconfirmed` + either `failedStep: 'poll'` or `poll_reason` | Poll ended without a failure verdict | Inspect status; waiting may be appropriate |
| `DEPLOY_READINESS_UNCONFIRMED` + `readiness_reason: 'final_state_mismatch'` | Orchestration final-state disagreement | Inspect and report a persistent provider/client mismatch |
| Usually `QUERY_FAILED` + `failedStep: 'poll'` without `readiness_unconfirmed` | Poll returned failure, terminal, or uninterpretable state | Re-query chain and provider; close only a chain-ACTIVE, provider-confirmed failed lease |

Absence of `poll_reason` alone is not a discriminator.

#### The readiness poll ended without a verdict

This is the branch when `details.failedStep === 'poll'` or `details.poll_reason` is present. `poll_reason` is optional: typed deadline and provider-unreachable outcomes set it and may include `last_state` / `last_provision_status`; a first-read auth rejection, oversized status body, or token-mint failure can set only `failedStep: 'poll'`. In every case the lease exists, the manifest is uploaded, and **the provider never reported the deployment as failed**. A cold image pull alone can take 5 minutes, and the provider is allowed 10.

This is not a failed deploy, and closing the lease here can tear down a deployment that is working. In order:

1. `app_status({ lease_uuid })` — is it ACTIVE with running instances?
2. `app_diagnostics({ lease_uuid })` — the `provision_status` and failure attribution. `details.last_provision_status` on the error tells you what the poll last saw.
3. `wait_for_app_ready({ lease_uuid, timeout_seconds: 600 })` — keep waiting.
4. Only once the provider reports a **failed** `provision_status`, or you've decided to abandon the deploy: `close_lease({ lease_uuid })`.

Raise the deadline up front with `deploy_app({ …, timeout_seconds })` if your images are large.

#### The final provider state disagreed with readiness

For `DEPLOY_READINESS_UNCONFIRMED`, this branch has `details.readiness_reason === 'final_state_mismatch'`. The callback-oriented orchestration flow's readiness operation returned, but its canonical final state was absent, malformed, or a value other than `LEASE_STATE_ACTIVE`. `details.state_source` names the response field and bounded `details.observed_state` records what was seen; the client refuses to turn the disagreement into a successful ACTIVE result.

Inspect `app_status({ lease_uuid })` and `app_diagnostics({ lease_uuid })`. If the provider repeatedly omits or malforms the state, or reports a non-ACTIVE state after declaring readiness, capture the error message and provider response and report a provider/client compatibility issue. Do not blindly wait or redeploy; act on the verified lease state once the disagreement is understood.

### Readiness polling stopped on a provider state

`details.failedStep === 'poll'` with no `details.readiness_unconfirmed` is a different partial-success outcome, normally coded `QUERY_FAILED`. Re-query `app_status` and treat its on-chain `chainState` as authoritative:

- Chain ACTIVE with a recognized failed provider `provision_status`: inspect `app_diagnostics` / logs, then close the failed lease, even if the provider's lease-state field now says terminal.
- Chain CLOSED, REJECTED, or EXPIRED: the lease is already inactive; no cleanup transaction is needed.
- Chain ACTIVE while the provider reports CLOSED, REJECTED, or EXPIRED without a recognized failed `provision_status`: this is a source mismatch. The lease remains active and may still be billing; do not mistake the provider state for on-chain closure.
- An unexpected or unrecognized chain or provider state: preserve the lease, capture `app_status` / diagnostics, and report the mismatch.
- `app_status` throws, or returns `providerError` without `fredStatus`: the re-check itself is inconclusive. Preserve both the original partial-deploy error and the lease, then retry diagnosis later.

Do not close solely because `failedStep` is `poll`, and do not start another readiness wait after a confirmed failure. A diagnostic re-query must not replace the original partial-deploy error if it fails.

### Set-domain, manifest-upload, or pre-step callback failure

`details.failedStep` is `set_domain` or `upload`; a library callback that fails immediately after lease creation can omit `failedStep`. The manifest is not running on the lease and you're paying for it. Either retry the failing step when appropriate (providers can be transiently unhealthy), or close the orphaned lease with `close_lease({ lease_uuid })`. If that cleanup fails, report its error separately and retain the original partial-deploy error: its `lease_uuid`, provider context, and failed-step metadata remain the recovery record.

## App is stuck in `LEASE_STATE_PENDING`

Check the provider:

1. `app_diagnostics({ lease_uuid })` — `provision_status`, `fail_count`, and the failure attribution `reason` / `message` / `next_step`.
2. `get_logs({ lease_uuid, tail: 200 })` — container output (will be empty if the image hasn't pulled yet).
3. `app_status({ lease_uuid })` — chain state vs provider state may differ when something failed during provisioning.

Common causes:
- Image registry is allowlisted differently than you expected (the `allowed_registries` list isn't on-chain — it's provider config, only checked at upload time).
- Image is private and the provider doesn't have credentials.
- Tags don't exist (e.g. `myapp:lates` typo).
- Resource limits in the SKU don't fit the container (rare; usually surfaces as a `ContainerExited` reason).

### Reading `reason`

`reason` is a stable, machine-readable failure category; `message` is a short human summary with no
host paths or raw command output. Both are omitted when no failure has been recorded. Providers
older than Fred v0.13.0 send a verbose `last_error` instead — the tools fall back to it and also
surface it on `message`, so either provider generation gives you a usable diagnosis.

| `reason` | Meaning | Who can act |
|---|---|---|
| `ContainerExited` | Container exited unexpectedly (crash, non-zero exit, OOM kill) | you |
| `ImagePullFailed` | The image could not be pulled | you |
| `Internal` | Internal provider error, not your workload | provider |
| `RestartFailed` | A restart you requested did not complete | you |
| `UpdateFailed` | An update failed and rolled back — **the app is still running the previous version** | you |
| `RestoreFailed` | A restore from retained data did not complete | you |
| `VolumeCleanupExhausted` | Volume cleanup failed after every retry | provider |
| `CleanupFailed` | Container/volume cleanup on deprovision failed | provider |
| `Unknown` | Marked failed with no specific cause recorded | you |

Two things to keep in mind:

- **The set is open and add-only.** A provider running a newer Fred may return a `reason` not listed
  here. That is expected, not an error: treat it as a generic failure and read `message`. The tools
  pass unknown values through untouched and simply omit `next_step`.
- **A non-empty `reason` does not mean the app is down.** Fred keeps the attribution on a healthy
  lease whose last update rolled back, so a `ready` app can legitimately report
  `reason: UpdateFailed`. Decide liveness from `provision_status`, not from the presence of `reason`.

## Auth token rejected by the provider

The provider enforces a 30-second max token age and 10-second max-future skew. If your machine clock drifts (especially in containers with a stale clock at startup), token construction will succeed but the provider will reject. Sync NTP. Replay attacks within the 30-second window are rejected by signature deduplication; the `AuthTimestampTracker` makes sure two consecutive calls don't share a timestamp.

## `SSRF blocked: … resolves to … which is in blocked range 'loopback'`

The provider/Fred fetch guard (`MANIFEST_FRED_FETCH_GUARDED`, on by default) resolves the target host at connect time and blocks any non-`unicast` IP. A provider or lease URL that passes the HTTPS-or-localhost scheme check but points at `localhost` / `127.0.0.1` / `::1` — common in local development against a provider on your own machine — is allowed by the URL validator but then **blocked at connect time** by the guard, surfacing as `SSRF blocked: <host> resolves to <ip> which is in blocked range 'loopback' (…)`.

To reach a localhost provider in development, disable the guard: `MANIFEST_FRED_FETCH_GUARDED=0` (fred) or `MANIFEST_AGENT_FETCH_GUARDED=0` (agent). Only do this in trusted local setups — the guard is what stops a malicious on-chain provider URL from reaching your internal network.

## "Tool returned a structured response that doesn't match its outputSchema"

This came up during the v0.7.0 rollout — `app_diagnostics` declared `last_error` as required when the provider can omit it. If you see something similar now, file an issue with the tool name and the response payload; the schemas are pinned by tests and shouldn't drift silently.

Note that `last_error` is now a deprecated alias kept only for providers older than Fred v0.13.0; the current failure fields are `reason` and `message` (see [Reading `reason`](#reading-reason) above).

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
