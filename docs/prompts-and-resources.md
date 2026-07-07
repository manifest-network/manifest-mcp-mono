# Prompts and resources

The Fred server (`manifest-mcp-fred`) declares the `prompts: {}` and `resources: {}` capabilities in its server-info handshake and exposes the items below. The other four servers (chain, lease, cosmwasm, agent) currently expose only tools.

Prompts and resources are part of the MCP spec; the host UI surfaces them differently from tools. Hosts that don't speak prompts/resources simply ignore these — the tools are still available.

## Prompts

Prompts give an MCP host ready-made workflows the LLM can invoke without rebuilding the orchestration each time. They expose a `title`, a `description`, and an optional `argsSchema` of typed inputs. When invoked, they return a fully-formed user-role message that walks the agent through the workflow.

### `deploy-containerized-app`

End-to-end deploy lifecycle for a single containerized app: pre-flight check, manifest preview, `deploy_app`, then `wait_for_app_ready`. Always asks for explicit user confirmation before broadcasting the chain TX.

| Argument | Type | Required | Description |
|----------|------|:--------:|-------------|
| `image` | string | yes | Public Docker image, e.g. `nginx:1.25` |
| `port` | string | no | TCP port (string-encoded; the agent must parse to integer for the tool calls). Required for single-service deploys. |
| `size` | string | no | SKU tier name, e.g. `docker-micro`. If omitted, the agent calls `browse_catalog` and asks the user to pick. |

**Workflow the prompt enforces:**

1. `check_deployment_readiness({ size, image })` — stop if `ready: false` and surface `missing_steps`.
2. `build_manifest_preview({ image, port })` — stop if `validation.valid: false` and surface every error verbatim.
3. Print a deployment plan (image, manifest summary, SKU, provider, `meta_hash`) and wait for an explicit "yes".
4. `deploy_app(...)` — broadcast. Forward any `progressToken` the host provides.
5. `wait_for_app_ready({ lease_uuid })` — on success, print lease UUID, provider URL, and endpoints. On failure, surface diagnostics and offer `close_lease`.

### `diagnose-failing-app`

Triage flow for a misbehaving lease. Bundles `app_status`, `app_diagnostics`, and `get_logs` into a structured report.

| Argument | Type | Required | Description |
|----------|------|:--------:|-------------|
| `lease_uuid` | string | yes | UUID of the lease to diagnose |

**Workflow the prompt enforces:**

1. `app_status({ lease_uuid })` — record chain state and (if present) `fredStatus`.
2. `app_diagnostics({ lease_uuid })` — record `provision_status`, `fail_count`, `last_error`.
3. `get_logs({ lease_uuid, tail: 200 })` — capture the most recent logs.
4. Summarize lease state, provider state, the most relevant log lines, and one concrete next step.

### `shutdown-all-leases`

Lists the caller's active and pending leases and walks through closing each one. Always confirms with the user before broadcasting `close_lease`.

(No arguments.)

**Workflow the prompt enforces:**

1. Read `manifest://leases/active`. Stop if empty.
2. Print a numbered table of `{ uuid, state, provider_uuid, created_at }` and ask "close all (N), some, or none?".
3. For each approved UUID, call `close_lease({ lease_uuid })`.
4. Print `{ lease_uuid, status }` after each close.
5. Print a final summary: closed count, skipped count, errors.

## Resources

Resources are pull-on-demand context an agent can read up-front instead of polling tools. Each is fetched on access — there is no caching layer.

### `manifest://leases/active`

Snapshot of the caller wallet's leases currently in `LEASE_STATE_ACTIVE` or `LEASE_STATE_PENDING`. Useful as immutable context when an agent is about to operate on "the app I have running".

```text
{
  "tenant": "manifest1abc...",
  "active":  [{ "uuid", "state", "provider_uuid", "created_at" }, ...],
  "pending": [{ "uuid", "state", "provider_uuid", "created_at" }, ...],
  "counts":  { "active": N, "pending": M }
}
```

### `manifest://leases/recent`

The caller's leases ordered most-recent-first, up to 50, **regardless of state**. Useful for surfacing recently-closed or rejected leases the agent may want to act on.

```text
{
  "tenant": "manifest1abc...",
  "leases": [
    { "uuid", "state", "provider_uuid", "created_at", "closed_at" }
  ],
  "total": "N"   // bigint serialized as string
}
```

### `manifest://providers`

Provider catalog snapshot — chain-side data only. No live HTTP health probe. Use `browse_catalog` (a tool, not a resource) when health is needed. Only **active** providers and **active** SKUs are returned (the query passes `activeOnly: true`), so the `active` field is always `true`.

```text
{
  "providers": [{ "uuid", "address", "api_url", "active" }],
  "skus":      [{ "uuid", "name", "provider_uuid", "active",
                  "base_price": { "amount", "denom" } | null }],
  "counts":    { "providers": N, "skus": M }
}
```

## Adding new prompts and resources

Both registries live in `packages/fred/src/server/`:

- `register-prompts.ts` — call `mcpServer.registerPrompt(name, { title, description, argsSchema? }, handler)`. The handler returns `{ messages: [{ role, content: { type: 'text', text } }] }`.
- `register-resources.ts` — call `mcpServer.registerResource(name, uri, { title, description, mimeType }, asyncHandler)`. The handler receives the parsed `URL` and returns `{ contents: [{ uri, mimeType, text }] }`.

If you add a resource that triggers chain reads, remember to acquire a rate-limit token (`clientManager.acquireRateLimit()`) before each query so the resource respects the same backpressure as the tools.
