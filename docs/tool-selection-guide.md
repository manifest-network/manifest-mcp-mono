# Tool selection guide

Which MCP server (and which tool) should an agent reach for? This page is meant to be read alongside the per-package READMEs and the `list_modules` / `list_module_subcommands` discovery tools that the chain server exposes.

## Pick the server

Wire up the smallest set of servers that covers your workflow. Each runs as a separate stdio process and registers an independent set of MCP tools.

| Server | Use it when… |
|--------|--------------|
| `manifest-mcp-chain` | You need generic Cosmos SDK access: balance/account queries, sending tokens, voting, delegating, governance, IBC, wasm contracts, anything routed through `cosmos_query` / `cosmos_tx`. Also exposes module discovery (`list_modules`, `list_module_subcommands`) and fee estimation (`cosmos_estimate_fee`). |
| `manifest-mcp-lease` | You need on-chain lease primitives without dragging in provider HTTP calls: balances on the billing credit account, funding credits, listing leases, claiming a custom domain, looking up a lease by domain, listing SKUs and providers. Pure on-chain reads/writes; no off-chain HTTP. |
| `manifest-mcp-fred` | You're operating a *deployed app*: catalog browsing with health checks, pre-flight readiness, manifest preview, deploying, polling-until-ready, status, logs, restart, update, diagnostics, releases. This server is the only one that talks to provider/Fred HTTP APIs. |
| `manifest-mcp-cosmwasm` | You're converting MFX to PWR through the on-chain converter contract (`get_mfx_to_pwr_rate`, `convert_mfx_to_pwr`). Requires `MANIFEST_CONVERTER_ADDRESS`. |

If your workflow spans more than one server (e.g. funding credits *and* deploying), wire up multiple servers — they share the same wallet via the keyfile.

## Pick the tool

### Read-only chain queries

Default to the **chain server** with `cosmos_query`. Discover the module/subcommand pair via `list_modules` then `list_module_subcommands`. The lease server's `credit_balance`, `leases_by_tenant`, `get_skus`, and `get_providers` are convenience wrappers — they save the agent a discovery round-trip when the question is specifically about lease state.

| Question | Tool |
|----------|------|
| "What's my MFX balance?" | `cosmos_query bank balances <address>` (chain) |
| "What lease do I have running on `app.example.com`?" | `lease_by_custom_domain` (lease) |
| "What's my credit balance?" | `credit_balance` (lease) |
| "Show me all my open leases" | `leases_by_tenant` (lease) |
| "What providers are healthy right now?" | `browse_catalog` (fred) — chain query alone won't tell you whether the provider is reachable |
| "What providers exist on chain?" | `get_providers` (lease) — chain-only, no health probe |
| "Who validates this chain?" | `cosmos_query staking validators` (chain) |

### Token movements

| Action | Tool |
|--------|------|
| Send MFX between accounts | `cosmos_tx bank send` (chain) |
| Fund someone's lease credit | `fund_credit` (lease) |
| Estimate fees before broadcasting | `cosmos_estimate_fee` (chain) |
| Convert MFX to PWR | `convert_mfx_to_pwr` (cosmwasm) — preview the rate first with `get_mfx_to_pwr_rate` |
| Request testnet tokens | `request_faucet` (chain, only when `MANIFEST_FAUCET_URL` is set) |

### Deploying and operating an app

The Fred server is sequenced; follow this order:

1. `browse_catalog` — see online providers and pick a SKU size.
2. `check_deployment_readiness` — surface missing prerequisites (insufficient balance, unfunded credits, unavailable SKU). The result is consumable by an agent: a single `ready: true/false` plus a human-readable `missing_steps` array.
3. `build_manifest_preview` — render the manifest the deploy will submit, with validation results and the on-chain `meta_hash`. **Run this before paying for a lease.** Catches bad env var names, wrong port format, malformed RFC 1123 service names, and a few dozen other rule violations.
4. `deploy_app` — broadcasts a chain TX. Optionally claims a custom domain in the same call. Pass a `progressToken` if the host supports `notifications/progress` so the user sees provisioning progress.
5. `wait_for_app_ready` — poll the provider until `LEASE_STATE_ACTIVE`. Don't loop `app_status` manually; this tool handles terminal-state detection and timeouts cleanly.
6. `app_status` / `get_logs` / `app_diagnostics` / `app_releases` — for inspection after deploy.
7. `restart_app` / `update_app` — for in-place changes that don't close the lease.
8. `close_lease` (lease server) — to terminate a lease. Destructive; use with care.

### Diagnosing a stuck or failing app

Prefer the `diagnose-failing-app` MCP prompt — it bundles `app_status`, `app_diagnostics`, and `get_logs` into a single triage workflow. See the [prompts reference](prompts-and-resources.md). Manually:

- `app_status({ lease_uuid })` — chain state + provider state.
- `app_diagnostics({ lease_uuid })` — `provision_status`, `fail_count`, `last_error`.
- `get_logs({ lease_uuid, tail: 200 })` — recent container output.

### Custom domains

| Action | Tool |
|--------|------|
| Claim a domain on an existing lease item | `set_item_custom_domain` (lease), or pass `custom_domain` to `deploy_app` (fred) when creating a fresh lease |
| Clear a domain | `set_item_custom_domain` with `clear: true` |
| Find which lease holds a domain | `lease_by_custom_domain` (lease) |
| Inspect domains across all your leases | `leases_by_tenant` (lease) — per-item output now surfaces `serviceName` and `customDomain` |

`service_name` is required for stack leases (multi-service) to address a specific item. Omit it for legacy single-item leases.

## Annotations and `_meta.manifest`

Every tool publishes two pieces of metadata that downstream hosts can use to decide whether to surface a confirmation prompt:

- Standard MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `title`).
- Manifest-specific `_meta.manifest` (`broadcasts`, `estimable`, plus `v: 1` for forward compatibility).

The `manifest-agent` plugin reads `_meta.manifest.broadcasts` to decide which tools require an explicit "yes" before they run. The annotation matrix is pinned by `tool-annotations.e2e.test.ts` — treat that test file as the public contract.

## Faucet behaviour

`request_faucet` is registered **only** when `MANIFEST_FAUCET_URL` is set on the chain server. It is read-only from the agent's perspective — the faucet operator's wallet (not the agent's) signs and broadcasts the funds — so it's annotated `readOnlyHint: false` (mutates external state) but `_meta.manifest.broadcasts: false` (the agent doesn't sign). Each denom has an independent cooldown enforced server-side. Omit the `denom` arg to drip every available denom.
