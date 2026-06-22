# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Upgrade notes

**BREAKING (agent-core / headless `deployApp` callers):**
- `deployApp`'s input is now the canonical `AppDeploySpec` (from `@manifest-network/manifest-mcp-core`); the `SingleServiceSpec | StackSpec` union (and `ServiceDef`) is removed. Migrate by importing `AppDeploySpec`; `services` is `Record<string, ServiceConfig>` with map-shaped `ports`.
- `size` is now **required** (it was silently defaulted to `'small'`). Pass an explicit tier (or pin `skuUuid`); discover tiers via the lease server's `get_skus`.

## [0.13.1]

### Fixed
- **fred:** `pollLeaseUntilReady` now waits for the provider's `provision_status` to settle before reporting a lease ready, instead of returning the moment the chain lease state reaches `ACTIVE`. Previously `deployManifest` / `waitForAppReady` could report a lease "running" while the container was still provisioning, or after it had crashed. When `ACTIVE`: keep polling while `{provisioning, restarting, updating, failing, unknown}`, throw `ProviderApiError` on `{failed, deprovisioning}`, and return otherwise — backward-compatible (providers that don't populate the field still return at `ACTIVE` as before). `provision_status` is added to the timeout diagnostic. (ENG-291)

## [0.13.0]

### Fixed
- **fred:** the main barrel (`@manifest-network/manifest-mcp-fred`) no longer pulls in the MCP server entry. `FredMCPServer` and `createMnemonicFredServer` moved to a Node-only `@manifest-network/manifest-mcp-fred/server` subpath, so importing a capability function (`deployManifest`, `restartApp`, `deployApp`, …) from the barrel no longer drags in `server/*` / the SSRF `fetch-gate` / core's Node-only `/guarded-fetch` — browser consumers can bundle the barrel again. Completes ENG-281 (which fixed core's barrel but exposed that fred's barrel was *also* bundling its server). (ENG-287)

### Upgrade notes
- **BREAKING (fred server consumers):** `FredMCPServer` and `createMnemonicFredServer` are **no longer exported from the `@manifest-network/manifest-mcp-fred` barrel** — import them from the `@manifest-network/manifest-mcp-fred/server` subpath instead. Change `import { FredMCPServer } from '@manifest-network/manifest-mcp-fred'` to `import { FredMCPServer } from '@manifest-network/manifest-mcp-fred/server'`. The browser-safe capability functions (`deployApp`, `deployManifest`, `restartApp`, `updateApp`, `appStatus`, `browseCatalog`, manifest helpers, HTTP wrappers, types) stay on the barrel. (ENG-287)

## [0.12.0]

### Changed
- **core:** the SSRF-guarded fetch — `createGuardedFetch`, `isBlocked`, `BLOCKED_RANGES_IPV4` / `BLOCKED_RANGES_IPV6`, and the `GuardedFetch` type — is now exported from a Node-only `@manifest-network/manifest-mcp-core/guarded-fetch` subpath instead of the package barrel. The universal barrel (`@manifest-network/manifest-mcp-core`) no longer drags `undici` (→ `node:async_hooks`) into the module graph, so browser bundlers (rspack/webpack/vite) can import the barrel again. In-repo consumers (`fred`, `agent-core`) were updated to the subpath. (ENG-281)
- **fred:** new public exports `deployManifest`, `DeployManifestInput`, `SkuSelector`, `DeployManifestOptions`; `deployApp` is now a thin wrapper over `buildManifest`/`buildStackManifest` + `deployManifest` (behavior unchanged). `findSkuUuid` gains an optional `providerUuid` filter. Pre-resolved `{ kind: 'resolved' }` SKU selectors skip the on-chain SKU lookup; storage SKUs resolve against the compute provider (ENG-258 #1/#2). Partial-success errors now carry `details.partial`/`details.failedStep`; a cancelled deploy is coded `OPERATION_CANCELLED` (non-retryable); the `Deploy partially succeeded:` message prefix is retained. (ENG-280)

### Security
- **fred:** `deployManifest` validates the manifest string at the boundary before any on-chain tx — manifest size cap, `__proto__`/`constructor` rejection, and a case-folded top-level-key collision check (the Go field-matching differential). (ENG-280)

### Upgrade notes
- **BREAKING (core library consumers):** `createGuardedFetch`, `isBlocked`, `BLOCKED_RANGES_IPV4`, `BLOCKED_RANGES_IPV6`, and the `GuardedFetch` type are **no longer exported from the `@manifest-network/manifest-mcp-core` barrel** — import them from the `@manifest-network/manifest-mcp-core/guarded-fetch` subpath instead. Change `import { createGuardedFetch } from '@manifest-network/manifest-mcp-core'` to `import { createGuardedFetch } from '@manifest-network/manifest-mcp-core/guarded-fetch'`. The barrel dropped them so it stays browser-bundleable (no `undici` / `node:async_hooks` in the module graph). (ENG-281)

## [0.11.0]

### Security

- Security(deps): pin `axios` (exact `1.16.1`) and `protobufjs` (exact `7.6.2`) via the **root** `package.json` `overrides`, and lift the load-bearing `@cosmjs/stargate` → `@manifest-network/stargate` fork alias to root. `packages/core`'s `overrides` block was dead config — npm honors `overrides` only at the repo root — so the prior `axios` pin never applied and the tree resolved vulnerable `axios` (`1.8.2`/`1.13.5`) plus `protobufjs@6.11.6` (the CRITICAL RCE advisory GHSA-xq3m-2v4x-88gg). `npm audit` dropped from 24 vulnerabilities (1 critical, 10 high) to 7 (all low — elliptic / `@cosmjs`-crypto, tracked for a later CosmJS 0.34 bump). (ENG-269, ENG-270)
- Security(fred): route all provider/Fred HTTP through an SSRF-guarded `fetch` by default. The standalone `manifest-mcp-fred` server made authenticated ADR-036 requests to on-chain-sourced provider URLs on unguarded `globalThis.fetch` — an SSRF + bearer-token-leakage surface. The connect-hook SSRF guard (DNS-resolve + `ipaddr.js` range default-deny at connect time, closing the DNS-rebinding window) moved from `agent-core` to **`core`** (the dependency-legal shared home); `FredMCPServer` now injects it by default, gated by the new `MANIFEST_FRED_FETCH_GUARDED` env var (default ON; opt out with `=0`). `core` now exports `createGuardedFetch` / `isBlocked` / `parseBooleanEnv`; `agent-core` re-exports them for backward compatibility. `undici` is a `core` `optionalDependency`, dynamic-imported so the `platform: "neutral"` build is preserved. (ENG-268)
- Security(deps): force `ipaddr.js` to `2.4.0` tree-wide via the root `overrides`, so the SSRF guard never resolves the stale transitive `1.9.1` (which misclassifies reserved ranges such as `198.18.0.0/15` and `100::/64` as `unicast`). (ENG-218)

### Changed

- Feat(agent-core): production-hardening of the deploy state machine (sub-PRs A–G). Full `classifyDeployResponse` routing + recovery paths (`retry_set_domain` via fred decomposition, partial-success handling), a type-safe `DeploySpec` → fred-input builder with correct ports shape, full `evaluateReadiness` invocation + a fred → camelCase translator, create-lease N-args per stack service + a permanent set-domain sentinel, and a `partial_success_prompt_rendered` ProgressEvent. Replaces the PR-3.x placeholders with real, regression-guarded behavior. (ENG-185)
- Fix(agent): apply a safe lease-preserving default when an `elicitInput` prompt is **rejected** (10-min timeout `MANIFEST_AGENT_ELICIT_TIMEOUT_MS`, host abort, or transport close) rather than resolved. Previously the SDK `McpError` surfaced as `code: UNKNOWN` *after a paid lease was created*. Now the recovery prompt defaults to the lease-preserving `salvage_without_domain` (never `stopApp`) and confirmation prompts decline (never broadcast), each emitting a `recovery_dismissed` / `elicit_timeout` warning. New `ManifestMCPErrorCode.OPERATION_CANCELLED` (non-retryable) **replaces `INVALID_CONFIG`** for every deliberate user decline/cancel/timeout — per the MCP elicitation spec these are `cancel` outcomes, not configuration faults. (ENG-272)
- Fix(core): ref-count `CosmosClientManager.disconnect()` so sibling MCP servers sharing a `chainId:rpcUrl` config key tear down the shared clients only when the last holder releases. (ENG-211)
- Refactor(agent): split the read-only reverse-lookup out of `manage_domain_orchestrated` into a new dedicated `lookup_custom_domain_orchestrated` tool (`packages/agent` now exposes **5** tools; the four agent-core DI-seam functions are unchanged — `lookup_custom_domain_orchestrated` reuses the unified `manageDomain` with `{ action: 'lookup' }`). `manage_domain_orchestrated` is now `set`/`clear` only — it always broadcasts a `MsgSetItemCustomDomain` tx and always requires an elicitation-capable host, so its `_meta.manifest.broadcasts: true` flag and unconditional `assertElicitationCapability` guard are now honest (previously the `lookup` action neither broadcast nor elicited, making the tool-level annotation a conservative over-statement). The new tool carries `readOnly` annotations + `broadcasts: false` and runs on hosts without MCP elicitation capability (mirrors `troubleshoot_deployment_orchestrated`). **Downstream:** the manifest-agent plugin's `PreToolUse` hook matcher must be updated to recognize `lookup_custom_domain_orchestrated` as read-only and to drop the special-case `manage_domain_orchestrated action=lookup` allowance — coordinate in a follow-up manifest-agent plugin release (manifest-network side; future work, not a v0.11.0 blocker). (ENG-212)

### Upgrade notes

- **Node.js `>=22.19.0` is now required** (`engines.node` raised from `>=20` across packages, matching the `undici` floor pulled in by the SSRF guard). Node 20/21 are no longer supported.
- **Error-code change:** a deliberate user decline / cancel / elicitation-timeout now reports `OPERATION_CANCELLED` (was `INVALID_CONFIG`). Update any consumer that branches on the error code.
- **New env var:** `MANIFEST_FRED_FETCH_GUARDED` (fred server; default ON). See `packages/node/.env.example`.
- **Downstream follow-up (not a v0.11.0 blocker):** the manifest-agent plugin (manifest-network side) will be updated in a future release cut against this version — its `PreToolUse` hook matcher needs to recognize `lookup_custom_domain_orchestrated` as read-only (ENG-212) **and** the new `OPERATION_CANCELLED` error code.

## [0.10.0]

- Feat(agent): new `@manifest-network/manifest-mcp-agent` package — MCP server wrapping `@manifest-network/manifest-agent-core` orchestration (`deployApp` / `manageDomain` / `troubleshootDeployment` / `closeLease`) via MCP **elicitation**. Translates agent-core's typed `onPlan` / `onConfirm` / `onProgress` / `onFailure` callbacks into standard `elicitation/create` requests and `notifications/progress` events, so any elicitation-capable host (Claude Code ≥ 2.1.76; any other MCP host advertising `capabilities.elicitation`) can drive the bidirectional plan / confirm / recovery flow over wire — no `AskUserQuestion`, no interactive stdin, no out-of-band channel. Four tools: `deploy_app_orchestrated`, `manage_domain_orchestrated`, `troubleshoot_deployment_orchestrated`, `close_lease_orchestrated`. The annotation + `_meta.manifest` matrix is a downstream-visible contract consumed by the manifest-agent plugin's `PreToolUse` hook. The wrapper is pure adapter — no orchestration logic, no re-rendering of agent-core's `internals/render-*.ts` outputs. Distributed as the `manifest-mcp-agent` binary alongside the four existing servers in `packages/node`'s `bin` block. Three new env-var contracts: `MANIFEST_AGENT_DATA_DIR` (deploy-only manifest persistence), `MANIFEST_CHAIN_DATA_FILE` (denom-map humanization, loaded once at startup), `MANIFEST_AGENT_FETCH_GUARDED=1` (gated dynamic import of agent-core's SSRF-guarded `createGuardedFetch`; `platform: 'neutral'` build preserved). Constructor exposes an `orchestrators?: Partial<AgentOrchestrators>` DI seam typed via `typeof realDeployApp` etc., so agent-core signature drift fails at compile time in the wrapper. Unblocks ENG-130 (plugin rewire). (ENG-204)
- Feat(core): export `__test-utils__/callToolWithElicitation` helper — scripted `ElicitRequest` responder paired with `InMemoryTransport` for unit-testing servers that mid-execute `server.elicitInput(...)`. Mirrors the existing `__test-utils__/callTool` shape; first consumed by `packages/agent`'s server tests.
- Docs(agent-core): the `private: true` stale-note has been replaced — `@manifest-network/manifest-agent-core` is publicly published on npm as of ENG-129.

## [0.9.0]

- Feat(agent-core): new `@manifest-network/manifest-agent-core` package — TypeScript orchestration surface for Manifest agent flows (`deployApp`, `manageDomain`, `closeLease`, `troubleshootDeployment`). Composes the chain/lease/fred tool functions directly (no MCP stdio hop) and exposes a host-callback surface so non-MCP consumers (Barney, standalone Node scripts) can drive an end-to-end deploy without re-implementing classification, verification, or recovery branching. Ports the plugin's CJS scripts to typed TS internals: per-domain classifiers (`classify-deploy-error`, `classify-deploy-response`), `verify-domain-state`, the generic `verify-recover` driver, SSRF-guarded fetch, image-inspection, fee-humanization, readiness-evaluation, and renderers. Parity with `manifest-agent-plugin` HEAD is enforced via fixture-replay tests (ENG-128, ENG-129).
- Fix(node): validate `MANIFEST_FAUCET_URL` through the same HTTPS / localhost-HTTP check used for `COSMOS_RPC_URL` / `COSMOS_REST_URL` at chain CLI startup, closing an SSRF risk. The check is guarded by `if (rawFaucetUrl)` so unset / empty values (mainnet) are unaffected. Invalid URLs that previously would have failed at the first faucet call now fail at startup with a clearer error.
- Fix(core): `withErrorHandling` now applies `sanitizeForLogging` to both the MCP response and the log output. When the error message was redacted, the stack trace is suppressed in logs entirely so it cannot re-leak the original through `error.message`.
- Fix(core): widen `structuredResponse`'s `data` parameter from `Record<string, unknown>` to `unknown` and drop the resulting `as unknown as Record<string, unknown>` double-casts in chain / lease / fred. `Record<string, unknown>` is assignable to `unknown`, so existing callers continue to compile; typed result interfaces no longer need a cast. Runtime contract (object-shaped after JSON round-trip) is unchanged.
- Fix(cosmwasm): tighten converter-config parsing — explicitly reject `null` and arrays before destructuring, then narrow on each field's type. Same `QUERY_FAILED` error code; the type guard now actually narrows.
- Fix(core): externalize `vitest` from the build graph by declaring it as an optional `peerDependency`. Previously the `__test-utils__/mocks.ts` export pulled vitest's transitive graph into rolldown's chunk graph, and on worktree paths containing `+` (characters rolldown's filename sanitizer mangles) the `[name]` substitution produced an invalid relative path and the build failed.
- Feat(core): export `validateEndpointUrl` for downstream reuse (now consumed by `packages/node/src/chain.ts` for faucet URL validation).
- Feat(fred): export `AuthTimestampTracker` (previously internal). Pin the ADR-036 sign-message wire format with a regression test plus an in-source security note flagging that adding an operation scope requires coordinated server-side validation.
- Refactor(fred): split `packages/fred/src/index.ts` (1,363 lines) into `server/{progress,register-tools,register-resources,register-prompts}.ts`. `FredMCPServer` class shape and exports are unchanged.
- Test(core): cover the rate-limiter token-bucket budget, throttling, and reconfig branches that previously had no unit test. Cover the encrypted-keyfile decrypt path and wrong-password rejection in `keyfileWallet.test.ts` (was plaintext-only at unit level).
- Docs: add a top-level `docs/` tree (tool-selection guidance, end-to-end usage examples, Fred's prompts / resources, troubleshooting, threat model, library-usage patterns for non-MCP consumers). Add `SECURITY.md` with a coordinated-disclosure policy. Refresh tool counts (6 / 8 / 11 / 2) across `README`, `ARCHITECTURE.md`, and per-package READMEs. Extend `packages/node/.env.example` with every documented env var so a fresh `.env` doesn't silently miss an option.

## [0.8.0]

- Feat(fred): `deploy_app` description now mentions the optional `custom_domain` attachment so the top-level summary an MCP host shows in `tools/list` reflects the tool's actual surface.
- Refactor(billing): align all custom-domain input-validation throws on `INVALID_CONFIG` so the same logical issue (empty / whitespace `custom_domain`, mutual exclusion, malformed `service_name`, mutually-exclusive `--clear-*` + values) produces the same error code regardless of whether the input arrives via `set_item_custom_domain`, `lease_by_custom_domain`, `cosmos_tx billing set-item-custom-domain`, `cosmos_query billing lease-by-custom-domain`, the `setItemCustomDomain` core helper, or `deploy_app`'s eager pre-flight. Both `INVALID_CONFIG` and the previously-used `TX_FAILED` are non-retryable, so retry behaviour is unchanged. Chain-side rejections (the actual `MsgSetItemCustomDomain` / `Query/LeaseByCustomDomain` failures, including the keeper's `NotFound` for an unclaimed FQDN) keep their existing codes (`TX_FAILED` / `QUERY_FAILED`) — those classify "the chain answered no", not "your input was bad".
- Feat(fred): `deploy_app` accepts an optional `custom_domain` (and `service_name` for stack leases) so a tenant can claim an FQDN in the same call that creates the lease. The set-domain tx is submitted between create-lease and the manifest upload — providerd has the domain available when it provisions. Failures slot into the existing partial-success error wrap (`Deploy partially succeeded: lease X was created but subsequent steps failed. Close this lease with close_lease if needed.`), so callers don't see a new error shape per failure mode. Input validation (empty / whitespace-only domain, missing or mismatched `service_name` on a stack lease, stray `service_name` on a single-item lease) fires before any chain tx so a misconfigured deploy doesn't leave a paid-for lease behind.
- Feat(lease): add `set_item_custom_domain` MCP tool that sets or clears the FQDN on a lease item via `MsgSetItemCustomDomain` (manifestjs 2.4.1 / manifest-ledger v2.1.0). Pass `custom_domain` to set, or `clear: true` to remove. Optional `service_name` addresses the LeaseItem inside a stack lease; omit for a 1-item legacy lease. Authorised signers are the lease tenant, the module authority, or any address in `params.allowed_list`. Annotated as non-destructive + idempotent (re-setting the same value is a no-op).
- Feat(lease): add `lease_by_custom_domain` MCP tool — reverse-lookup the active or pending lease that has claimed a given FQDN; returns the lease and the `service_name` of the item holding the domain (empty string for legacy 1-item leases).
- Feat(lease): `leases_by_tenant` per-item output now surfaces `serviceName` and `customDomain` so callers can see which lease item owns a domain without a second query.
- Feat(core/billing): add `lease-by-custom-domain` query subcommand and `set-item-custom-domain` transaction subcommand to the generic `cosmos_query` / `cosmos_tx` surface. New `--service-name <name>` flag selects the LeaseItem inside a stack lease; `--clear` clears the existing domain.
- Feat(core/billing): `update-params` now preserves the on-chain `allowed_list` and `reserved_domain_suffixes` by default. Before broadcast, `cosmosTx` reads the current `Params` and threads them as a `TxBuildContext` so the message-builder fills in any list field the caller did not explicitly override. Pass `--reserved-suffix <.example.com>` (repeatable) or trailing positional `<allowed-address>...` to overwrite a list; pass `--clear-reserved-suffixes` or `--clear-allowed-list` to explicitly empty one. Mixing positional addresses with `--clear-allowed-list`, or `--reserved-suffix` with `--clear-reserved-suffixes`, is rejected with a structured `INVALID_CONFIG`. The previous behaviour silently cleared whichever list the caller did not enumerate, since `MsgUpdateParams` overwrites the full `Params` struct.
- Feat(core): add `TxBuildContext` type and an optional 7th `context` parameter to `TxHandler` / 4th to `TxMsgBuilder`. Existing handlers ignore it; `routeBillingTransaction` consumes `context.currentBillingParams` to drive the preserve-by-default behaviour above. `cosmosTx` and `cosmosEstimateFee` look up an optional `TxBuildContextLoader` in the per-module `TX_MODULES.contextLoaders` registry and run it before dispatching, so each handler that needs chain state declares its own loader inline (`loadBillingUpdateParamsContext` is the first). The dispatcher acquires a rate-limit token before the loader runs and wraps non-`ManifestMCPError` failures as `QUERY_FAILED` with `{module, subcommand}` details, so broadcast and estimate paths see symmetric error classification. Subcommands without a loader pay no extra round-trip.
- Feat(core): export `setItemCustomDomain` helper (mirrors `stopApp` / `fundCredits`) and `LeaseByCustomDomainResult` type.
- Test(e2e): add `e2e/billing-custom-domain.e2e.test.ts` covering set/lookup/clear via both the lease MCP tools (`set_item_custom_domain`, `lease_by_custom_domain`, `leases_by_tenant`) and the generic chain layer (`cosmos_tx billing set-item-custom-domain`, `cosmos_query billing lease-by-custom-domain`) against the local devnet, plus chain-side and client-side rejection paths.
- Chore(e2e): bump the `submodules/manifest-ledger` pin from the `fmorency/manifest-ledger` fork (`billing-v2` @ `0031210`) to upstream `manifest-network/manifest-ledger` (`v2.1.0` / `0319a7c`). Required to ship the chain image with `MsgSetItemCustomDomain` and `Query/LeaseByCustomDomain` registered — manifestjs 2.4.1 was generated from upstream v2.1.0, so the chain proto types must match. `e2e/billing-custom-domain.e2e.test.ts` probes for the new query in `beforeAll` and skips gracefully on older chains.
- Chore(deps): bump `@manifest-network/manifestjs` to 2.4.1

## [0.7.0]

- Fix(fred): `FredLeaseProvision.last_error` is now declared optional in the public TypeScript interface, matching the runtime behavior the M1 outputSchema fix already reflects. Removes an unsafe `undefined as unknown as string` cast from the regression test (ENG-87).
- Fix(fred): `app_diagnostics` outputSchema declares `last_error` as optional. The Fred provider omits the field when there's no recent failure, so the M1 schema (`last_error: z.string()`) was rejecting valid responses with `Output validation error: expected string, received undefined`. Caught by nightly e2e (ENG-87 fixup of ENG-84).
- Fix(fred): `build_manifest_preview` now throws `INVALID_CONFIG` when called with `services: {}`. Previously the empty stack round-tripped into a single-service classification (since `isStackManifest` returns false for empty services), producing misleading `services: unknown field` and `image: required` validation errors. The function's docstring promises that hard structural failures throw — empty services qualifies (ENG-84).
- Fix(fred): replace the literal NUL byte (`U+0000`) embedded in `manifest.ts:387` with the explicit `'\0'` escape. Code behavior is unchanged (it was, and still is, checking for NUL — matching the env-name "cannot contain '=' or NUL" error message); the source is now reviewable in editors and `git diff` without the NUL being silently rendered as a space (ENG-84).
- Fix(fred): clarify `check_deployment_readiness.missing_steps` strings to spell out that `fund_credit` lives on the `manifest-mcp-lease` server, not fred. The `manifest-agent` plugin connects to all four servers so the tool is reachable, but the previous wording could mislead any host that wires fewer (ENG-84).
- Fix(fred): cap `available_sku_names` in `check_deployment_readiness` to 50 entries so a large catalog cannot bloat MCP responses. The chain query is bounded by `MAX_PAGE_LIMIT` (1000); 50 mirrors the spirit of the existing 10-item slice in the `missing_steps` "Pick one of: …" message. The exact `size` lookup still uses the full unbounded `Map` (ENG-84).
- Fix(fred): cross-service `depends_on` validation in `validateManifest` now uses a precomputed Set of service names instead of `Array.includes` inside a nested loop. Linear in total dep edges instead of O(services × deps × services). Practical impact at typical 1–10 services is negligible; the change is for clarity (ENG-84).
- Fix(fred): reject ports > 65535 in `validateManifest`. The previous `PORT_KEY_RE` permitted up to 5 digits (allowing 65536–99999), so a manifest with `"70000/tcp"` could silently pass `build_manifest_preview` even though the error message claimed 1–65535. Now post-checks the captured port via the existing `validatePort()` helper, mirroring the `expose` block (ENG-84).
- Fix(core): `structuredResponse` now applies the optional `replacer` to `structuredContent` (not just the text fallback). Round-trips through `JSON.parse(JSON.stringify(data, replacer))` so the over-the-wire payload is JSON-safe even when callers pass values like `BigInt` that the SDK can't serialize directly. Closes the abstraction footgun where the parameter implied BigInt support but the wire path silently bypassed the replacer (ENG-84).
- Feat(chain/lease/fred): retrofit `outputSchema` on the high-value tools that previously returned text-only JSON. `cosmos_estimate_fee`, `credit_balance`, `browse_catalog`, `app_status`, `app_diagnostics`, `app_releases`, `update_app`, and `deploy_app` now declare their structured output and emit `structuredContent` alongside the JSON text fallback. Clients that validate against `outputSchema` get type-checked responses; clients that don't keep working unchanged (ENG-84).
- Feat(fred): register three MCP prompts via `registerPrompt`: `deploy-containerized-app` (full deploy lifecycle with explicit confirmation gate, parameterized by image/port/size), `diagnose-failing-app` (triage flow combining app_status + app_diagnostics + get_logs for a given lease_uuid), and `shutdown-all-leases` (close-all workflow that lists active leases first and confirms before broadcasting). Adds the `prompts: {}` capability. Prompts give MCP hosts ready-made workflows the LLM can invoke without rebuilding the orchestration each time (ENG-84).
- Feat(fred): expose three MCP resources via `registerResource`: `manifest://leases/active` (caller's active+pending leases), `manifest://leases/recent` (last 50 leases of any state, reverse order), and `manifest://providers` (provider catalog snapshot, chain-side only). Adds the `resources: {}` capability to the fred server. Resources let an agent pull live context up-front instead of repeatedly polling tools (ENG-84).
- Feat(fred): add `check_deployment_readiness` MCP tool — a single-call pre-flight that returns wallet balances, credit account status, SKU availability, and a human-readable `missing_steps` list before `deploy_app`. Lets agents decide whether to fund credits, switch SKU, or top up the wallet without making three separate queries. Provider `allowed_registries` is operator config and not exposed via chain or public API, so `ready: true` does not guarantee `image`'s registry is allowed; the upload step is the runtime gate (ENG-84).
- Feat(fred): `deploy_app` and `wait_for_app_ready` now emit `notifications/progress` when the client passes a `progressToken` (or sets `onprogress` via the SDK). Progress messages cover the lease-created milestone and each provider poll iteration with the current `LeaseState` and `provision_status`. Both tools also forward the request's `AbortSignal` so a cancelled MCP request stops the upload/poll cleanly. No-op when the client doesn't request progress (ENG-84).
- Feat(fred): add `build_manifest_preview` MCP tool that builds, validates, and SHA-256-hashes a deployment manifest without touching the chain or any provider. Accepts a raw JSON `manifest` string OR structured fields mirroring `deploy_app` (image+port, or services). Returns the canonical `manifest_json`, the `meta_hash_hex` that would be recorded on-chain, and an inline `validation` result enumerating any rule violations (env-name blocklist, `fred.*` label prefix, port format, tmpfs limits, RFC 1123 service names, depends_on placement, unknown fields). Use this before `deploy_app` to reject obviously-broken manifests without paying for a lease (ENG-84).
- Feat(fred): export `metaHashHex`, `validateManifest`, and `ManifestValidationResult`/`ManifestFormat` from the package. The same `metaHashHex` helper now backs `deploy_app`'s on-chain meta-hash so a preview's hash is structurally guaranteed to match the eventual lease's `meta_hash` (ENG-84).
- Feat(fred): add `wait_for_app_ready` MCP tool that wraps `pollLeaseUntilReady` so agents can wait on a lease reaching `LEASE_STATE_ACTIVE` without re-implementing the polling loop. Accepts `timeout_seconds` (1–600) and `interval_seconds` (1–60); declares an `outputSchema` with `lease_uuid`, `provider_uuid`, `provider_url`, `state`, and the raw provider `status` payload (ENG-84).
- Feat(core): add `structuredResponse` helper alongside `jsonResponse` for tools that declare an `outputSchema`. Returns both `structuredContent` (the typed payload) and a JSON `text` fallback so older clients keep working (ENG-84).
- Feat(core): add Proof-of-Authority (`poa`), tokenfactory, and IBC transfer (`ibc-transfer`) modules with query and transaction routing through `cosmos_query`/`cosmos_tx`/`cosmos_estimate_fee`. Tokenfactory `update-params` is intentionally not exposed pending an upstream `manifestjs` codegen fix (`MsgUpdateParams.params` is wired to `cosmos.bank.v1beta1.Params` instead of the local tokenfactory `Params`).
- Fix(core): validate `poa create-validator` JSON input with a strict zod schema; reject unknown keys, validate validator address valoper prefix, and base64-decode the `pubkey.value` so `Any.encode` produces correct wire bytes.
- Fix(core): require non-empty `source-port` and `source-channel` on `ibc-transfer transfer` instead of forwarding blank strings to the chain.

## [0.6.2]

- Fix(core): surface dropped proto fields in query handlers and `getBalance` (#41)

## [0.6.1]

- Feat(fred): add `checkChainState`, `onLeaseCreated`, `abortSignal`, and `pollOptions` hooks to `deployApp` and `pollLeaseUntilReady`; introduce `TerminalChainStateError` for chain-reported terminal lease states (#40)

## [0.6.0]

- Feat(lease): `fund_credit`, `credit_balance`, and `leases_by_tenant` accept optional `tenant` to operate on a third-party account (#38)
- Feat(lease): support optional `tenant` on more methods (#39)
- Chore(deps): bump `@manifest-network/manifestjs` to 2.3.0

## [0.5.0]

- Feat(chain): add `cosmos_estimate_fee` MCP tool (#35)

## [0.4.7]

- Fix(core): re-encode wasm LCD response data for fromJSON compatibility (#34)

## [0.4.6]

- Fix(core): base64-encode wasm `queryData` in LCD adapter (#33)

## [0.4.5]

- Fix(ci): re-release v0.4.4 which failed to publish all packages due to npm registry propagation delay

## [0.4.4]

- Fix(ci): pin npm to 11.5.1 for OIDC trusted publishing (10.9.2 was too old, lacked OIDC auth support)

## [0.4.3]

- Fix(ci): use `npx npm@10.9.2` to bootstrap npm upgrade, bypassing broken bundled npm on GitHub Actions runners

## [0.4.2]

- Fix(ci): use `--ignore-scripts` for npm self-upgrade in release workflow (insufficient — see 0.4.3)

## [0.4.1]

- Docs: add cosmwasm package across all documentation, fix stale tool/server/CLI counts, add missing env vars
- Fix(ci): add cosmwasm package to npm publish list in release workflow
- Fix(ci): update setup instructions from NPM_TOKEN to OIDC trusted publishing
- Fix(ci): remove npm self-upgrade step from release workflow (broke OIDC publishing — see 0.4.2)

## [0.4.0]

- Feat(cosmwasm): add new `packages/cosmwasm` MCP server with `get_mfx_to_pwr_rate` and `convert_mfx_to_pwr` tools for the on-chain MFX-to-PWR converter contract
- Feat(core): add CosmWasm query and transaction routing to the module registry
- Feat(core): per-transaction `gas_multiplier` override on `cosmos_tx`, allowing callers to adjust gas simulation per call
- Feat(node): add `manifest-mcp-cosmwasm` CLI entry point

## [0.3.5]

- Feat(core): configurable gas multiplier via `COSMOS_GAS_MULTIPLIER` env var (default `1.5`, must be >= 1)
- Fix(core): support factory and IBC denoms in gas price validation (e.g. `factory/manifest1.../umfx`, `ibc/...`)

## [0.3.4]

- Fix(chain): handle plain-text faucet `/credit` responses from CosmJS faucet (was crashing on `res.json()`)
- **Breaking**: remove `transactionHash` from `FaucetDripResult` (the CosmJS faucet never returns one)
- Test(chain): add faucet tests for all faucet HTTP status codes (200, 400, 405, 422, 500)

## [0.3.3]

- Fix(chain): align `FaucetStatusResponse` with real faucet API (`availableTokens` string[] instead of `tokens` Coin[])
- Fix(chain): handle plain-text `/credit` responses from CosmJS faucet (was crashing on `res.json()`)
- Fix(chain): validate full faucet `/status` response shape with zod
- Refactor(chain): consolidate faucet types (`FaucetHolder`/`FaucetDistributor` -> `FaucetAccount`)
- **Breaking**: remove `transactionHash` from `FaucetDripResult` (the CosmJS faucet never returns one)
- Test(chain): add faucet tests for all faucet HTTP status codes (200, 400, 405, 422, 500)

## [0.3.2]

- Fix(core): bump gas simulation multiplier to 1.5 to match CLI `--gas-adjustment`
- Fix(fred): add `AuthTimestampTracker` to guarantee unique auth token timestamps, preventing replay rejection on protected endpoints
- Fix(fred): send JSON with base64-encoded payload in `updateLease` instead of raw octet-stream
- Fix(fred): generate separate auth tokens for status and connection requests in `appStatus`
- Fix(e2e): use unprivileged nginx image, discover SKU denom dynamically, disable file parallelism

## [0.3.1]

- Fix: re-export faucet functions and types (`requestFaucet`, `requestFaucetCredit`, `fetchFaucetStatus`) from chain package entry

## [0.3.0]

- Feat: add `request_faucet` tool for chain server (enabled when `MANIFEST_FAUCET_URL` is set)
- Docs: fix inaccuracies and fill gaps across all documentation

## [0.2.3]

- Fix: include `--ignore-scripts` in lockfile sync recovery instructions
- Fix: make GitHub Release step idempotent on workflow re-runs

## [0.2.2]

- Fix: improve README accuracy and validate workspace package names
- Fix: add `--ignore-scripts` to lockfile sync, use `fileURLToPath` for Node 20.0 compatibility
- Docs: clarify GitHub Release creation is best-effort

## [0.2.1]

- Fix: set vitest root so E2E global setup and tests resolve correctly
- Fix: validate all workspace versions match tag, improve error message
- Feat: add tag-triggered npm release workflow and version script

## [0.2.0]

Initial public release.

- Three MCP servers: chain (5 tools), lease (6 tools), fred (8 tools)
- LCD/REST query-only mode for browser consumers
- ADR-036 provider authentication
- Encrypted keyfile wallet with `keygen` and `import` CLI subcommands
- Multi-service stack deployment support
- E2E test infrastructure with Docker Compose
- Biome for formatting, linting, and import sorting
- Tag-triggered npm publish workflow with provenance
