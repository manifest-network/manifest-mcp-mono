# Usage examples

End-to-end transcripts of natural-language requests and the MCP tool calls they translate into. The wallet, RPC URL, gas price, and (where applicable) `MANIFEST_FAUCET_URL` / `MANIFEST_CONVERTER_ADDRESS` are assumed to be configured per the [node README](../packages/node/README.md). The exact JSON payloads below are illustrative; an agent will format arguments to match each tool's input schema.

## 1. Check a balance

> "What's my MFX balance?"

```ts
// chain server
get_account_info()
// → { address: "manifest1abc..." }

cosmos_query({ module: "bank", subcommand: "balances", args: ["manifest1abc..."] })
// → { result: { balances: [{ denom: "umfx", amount: "10000000" }] } }
```

The agent will typically convert `umfx` to MFX (1 MFX = 1,000,000 umfx) before responding.

## 2. Send tokens

> "Send 50 MFX to manifest1xyz…"

```ts
// chain server — preview the fee first
cosmos_estimate_fee({
  module: "bank",
  subcommand: "send",
  args: ["manifest1xyz...", "50000000umfx"]
})
// → { gasEstimate: "...", fee: { gas: "...", amount: [...] } }

// confirm with the user, then broadcast
cosmos_tx({
  module: "bank",
  subcommand: "send",
  args: ["manifest1xyz...", "50000000umfx"]
})
// → { transactionHash: "...", code: 0, height: "...", events: [...] }
```

The `manifest-agent` plugin will gate `cosmos_tx` behind a confirmation step because it has `_meta.manifest.broadcasts: true`.

## 3. Request faucet tokens (testnet)

> "Top up my testnet wallet."

```ts
// chain server, only when MANIFEST_FAUCET_URL is set
request_faucet()                           // drips every available denom
request_faucet({ denom: "umfx" })          // drips a single denom
// → { address: "manifest1abc...", results: [{ denom: "umfx", success: true }] }
```

Each denom has an independent server-side cooldown.

## 4. Convert MFX to PWR

> "How much PWR will I get for 100 MFX, then make the conversion."

`amount` is a plain integer string in the source denom's base unit (umfx). No denom suffix.

```ts
// cosmwasm server — 100 MFX = 100_000_000 umfx
get_mfx_to_pwr_rate({ amount: "100000000" })
// → {
//     rate, source_denom, target_denom, paused, converter_address,
//     preview: { input_amount, input_denom, output_amount, output_denom }
//   }

// confirm with the user
convert_mfx_to_pwr({ amount: "100000000" })
// → { transactionHash, code: 0, height, events }
```

`MANIFEST_CONVERTER_ADDRESS` must be set or the cosmwasm server refuses to start.

## 5. Deploy a containerized app

> "Deploy `nginx:1.25` on a `docker-micro` SKU and tell me when it's ready."

The smoothest path is the `deploy-containerized-app` MCP prompt. Manually it looks like:

```ts
// 1. Pre-flight (lease server is required for fund_credit if credits are missing)
check_deployment_readiness({ size: "docker-micro", image: "nginx:1.25" })
// → { ready: true | false, missing_steps: [...], sku: { ... }, balances: [...] }

// 2. If credits are needed, fund them first (lease server)
fund_credit({ amount: "10000000umfx" })

// 3. Preview the manifest (no chain TX)
build_manifest_preview({ image: "nginx:1.25", port: 80 })
// → { manifest_json, format, meta_hash_hex, validation: { valid, errors: [] } }

// 4. Deploy (broadcasts a TX, takes a paid lease)
deploy_app({ image: "nginx:1.25", port: 80, size: "docker-micro" })
// → { lease_uuid, provider_uuid, provider_url, transaction_hash, ... }

// 5. Wait until ready
wait_for_app_ready({ lease_uuid: "..." })
// → { state: "LEASE_STATE_ACTIVE", status: { ... endpoints: [...] } }
```

If step 4 succeeds but a later step fails, the error returned by `deploy_app` includes the `lease_uuid` so you can either retry the upload or close the orphaned lease with `close_lease` (lease server).

## 6. Deploy with a custom domain

> "Deploy `myapp:latest`, claim `app.example.com` to it, and confirm."

```ts
// fred server — the FQDN is claimed in the same call that creates the lease
deploy_app({
  image: "myapp:latest",
  port: 8080,
  size: "docker-small",
  custom_domain: "app.example.com",
  // service_name is required for stack leases; omit for single-service
})
```

If the chain rejects the domain claim (e.g. it's already taken), `deploy_app` returns a partial-success error wrapping the live `lease_uuid`. The lease still exists — close it with `close_lease` if you don't want to keep paying for it.

## 7. Deploy a multi-service stack

Per-service objects accept `image`, `ports`, `env`, `command`, `args`, `user`, `tmpfs`, `health_check`, `stop_grace_period`, `depends_on`, `expose`, and `labels` — no `port` (singular) and no `accept` field. `ports` is a `{ "<port>/<proto>": {} }` map. The FQDN-claim lives at the top level via `custom_domain` + `service_name`.

```ts
// fred server
build_manifest_preview({
  services: {
    web: {
      image: "nginx:1.25",
      ports: { "80/tcp": {} }
    },
    db: {
      image: "postgres:16",
      env: { POSTGRES_PASSWORD: "..." }
    }
  }
})
// inspect manifest_json, then:
deploy_app({
  services: {
    web: {
      image: "nginx:1.25",
      ports: { "80/tcp": {} }
    },
    db: {
      image: "postgres:16",
      env: { POSTGRES_PASSWORD: "..." }
    }
  },
  size: "docker-small",
  custom_domain: "app.example.com",
  service_name: "web"     // required when claiming a domain on a stack
})
```

## 8. Diagnose a failing app

Run the `diagnose-failing-app` prompt. Or manually:

```ts
// fred server
app_status({ lease_uuid: "..." })          // chainState + fredStatus
app_diagnostics({ lease_uuid: "..." })     // provision_status, fail_count, last_error
get_logs({ lease_uuid: "...", tail: 200 }) // recent container output
```

Decide on a fix (different image? change in env? close and redeploy?) and act.

## 9. Update an app in place

> "Update `lease X` to use `myapp:v2`."

`update_app` takes a full manifest as a JSON string. The easiest path is to render one with `build_manifest_preview` and then feed the resulting `manifest_json` in. Pass the previous manifest as `existing_manifest` to merge over it (env, ports, labels merged; other fields carried forward).

```ts
// 1. Render the new manifest
const preview = build_manifest_preview({ image: "myapp:v2", port: 8080 });

// 2. Apply it (does not close or recreate the lease)
update_app({
  lease_uuid: "...",
  manifest: preview.manifest_json
  // optional: existing_manifest: <previous manifest_json>
})
```

## 10. Restart a stuck app

```ts
restart_app({ lease_uuid: "..." })
```

Use this when the container has crashed and you want to bounce it without redeploying.

## 11. Close a lease

> "Shut down the app on `lease X`."

Either invoke the `shutdown-all-leases` prompt (which lists everything first and asks for confirmation), or close one explicitly:

```ts
// lease server
close_lease({ lease_uuid: "..." })
// → { transactionHash, code: 0, ... }
```

`close_lease` is annotated `destructiveHint: true` and `_meta.manifest.broadcasts: true` — the manifest-agent plugin will gate it behind a confirmation prompt.

## 12. Discover what a module supports

> "What governance subcommands are available?"

```ts
// chain server
list_modules()
// → { queryModules: [{ name: "gov", description: ... }, ...], txModules: [...] }

list_module_subcommands({ type: "tx", module: "gov" })
// → { subcommands: [{ name: "vote", description, args }, ...] }
```

Useful to keep agent prompts compact: route the LLM through discovery instead of pre-loading every module's surface.

## 13. Use query-only mode

For read-only deployments (no signing key), set `COSMOS_REST_URL` instead of `COSMOS_RPC_URL`. The wallet is still required at startup (the bootstrap reads the keyfile or mnemonic) but `cosmos_tx`, `fund_credit`, `close_lease`, `deploy_app`, etc. will fail with `INVALID_CONFIG` because the signing client isn't initialized. `cosmos_query`, `credit_balance`, `leases_by_tenant`, and the read-only Fred tools all work.

When both `COSMOS_RPC_URL` and `COSMOS_REST_URL` are set, the REST endpoint is preferred for queries.
