# Manifest App SDK — Readiness Scorecard (living tracker)

- **Repo:** manifest-mcp-mono @ v0.14.0
- **Created:** 2026-06-10 · **Revised:** 2026-06-10 (v7 — big-picture re-review: branding scoped to 5 confusable ids; bound-method `ManifestClient` face; API Extractor deferred to external-publish/1.0; **P0 split P0a/P0b** + 5 zero-consumer reads → P0b)
- **Pairs with:** `2026-06-10-manifest-app-sdk-foundation-design.md` (Phase 0 spec)
- **Definition of done (single tracked metric) — two distinct claims:** **(a) it deploys** — the node example runs the full **deploy → query → connection → domain → restart/update/logs → batch → subscribe → stop** flow (single-service + stack) **end-to-end against the live `e2e/docker-compose` chain + Fred provider**; **(b) it bundles** — the *same example source* builds for the browser with **no node builtins + under the size budget**. Both compose **only** `@manifest-network/manifest-sdk` + `manifestjs` — zero hand-rolled client, queries, auth, pricing, orchestration, or streaming. (The browser bundle can't run the e2e — it hard-fails on the node-only `…/node` subpath the e2e path uses; same source, two toolchains.)

**Status legend:** ✅ ready (zero/trivial) · 🟡 exists, needs SDK-shaping · 🟠 partial / wrong place · 🔴 missing / net-new · ☑ done (tick as landed)

> The hard machinery already exists; the distance is mostly *exposing + unifying* it, plus one fidelity refactor (P1). **Correction (v2):** several "only in Barney" reads ALSO exist as stringly tools in the **lease server** over the same `core/queries` handlers — so the work is *unify into one typed core fn*, **not** *port from Barney*. Genuinely net-new (🔴) is concentrated in the SDK *surface* (ctx, pricing helpers, `paginateAll`, packaging, proof).

## Rollup

| Layer | Built | Needs shaping | Net-new |
|---|---|---|---|
| A. Client / DI / ports | high | medium | `CapabilityCtx` |
| B. Canonical types | — | — | relocate + `SkuIntent` + `PortConfig` + **branded types** |
| C. Reads | high (machinery + lease-server tools) | typed Face-B (unify) | `paginateAll`, account/withdrawable wrappers |
| D. Catalog / SKU / pricing | resolve+browse ✅ | — | cheapest/pricing/spec-map |
| E. Transactions | helpers ✅ | typed Face-B | faucet helper |
| F. Fred provider ops | ✅ | ctx DI (P2) | — |
| G. Orchestration | engine ✅ | — | DeploySpec superset (P1) |
| H. Packaging / proof / docs | — | servers→thin | SDK pkg + subpaths, example app, guards, docs |

## A. Client, DI seam, ports

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | Configured chain client (LCD/RPC) | ✅ | `core/src/client.ts` (CosmosClientManager), `core/src/lcd-adapter.ts` | Wrap in `createManifestClient()`; expose as `ctx.chain`/`ctx.query` (inherit restUrl-preferred routing) · **P0** |
| ☐ | Retry / rate-limit / error model | ✅ | `core/src/retry.ts`, `client.ts` limiter, `types.ts` ManifestMCPError | Expose; no logic change · **P0** |
| ☑ | `CapabilityCtx` / `QueryCtx` + bound `ManifestClient` (single DI seam, two faces) — **landed in 4d** (bound-method client completed by 4a–4d together) | 🔴 | none — two positional conventions (`clientManager`-first vs `queryClient`-first) | Define `{ chain, query, signer?, fetch, logger, events? }`; **two named factories (`createManifestClient` / `createManifestReadClient`) + the fred-layer `createFredClient`** → `ManifestReadClient`(no signer) vs `ManifestClient`; **bound-method client** (`client.getLeasesByTenant(…)`) extends the ctx (so it IS a ctx for the tree-shakable free fns); `client.chain`/`client.query` honest cosmjs/Telescope drop-downs; reads typed against `Pick<…,'query'\|'chain'>` (ISP) · **P0a** (full convergence **P2**) |
| ☐ | Signer port | 🟡 | `core/src/types.ts` `WalletProvider` (signArbitrary OPTIONAL; `getAddress(): string`) | **Type-split** `TxSigner` / `AuthSigner = TxSigner & { signArbitrary }` + `requireAuthSigner(ctx)`; `getSigner` returns **`@cosmjs/proto-signing`** `OfflineSigner` (the stargate fork overrides `@cosmjs/stargate`, not proto-signing); `Signer` is an **adapter over `WalletProvider`** that brands the address via `parseAddress` once · **P0** |
| ☐ | ADR-036 auth-token factory | 🟡 | `fred/src/http/auth-token-service.ts`, `auth.ts` (Barney: `src/ai/toolExecutor/fredAuth.ts` `makeFredAuthTokens`) | Expose `createAuthTokens(signer: AuthSigner, { chainId })`, **lazily cached / re-sign on expiry**; kill per-call closures · **P0** |
| ☐ | fetch port | ✅ | `fred/src/server/fetch-gate.ts`, core `…/guarded-fetch` subpath (`"default": null` guard) | Move onto ctx · **P0** |
| ☐ | **Logger port** (silent-by-default, injectable) | 🟠 | `core/src/logger.ts` — global mutable `console.error` singleton + process-global level | `Logger` interface + frozen `noopLogger` default on ctx (per-instance level, isomorphic, never touches console/process); node bootstrap adapts the legacy singleton via `LOG_LEVEL`; mark `@public` · **P0** |
| ☐ | **Per-call options bag** (`CallOptions`/`TxCallOptions` — distinct from core's existing internal `TxOptions`/`TxOverrides`) | 🔴 | none — reads/txs take no signal; tx `overrides?` exists but the spec'd new sigs dropped it | `{ signal?, timeout? }` on reads, `{ …, gasMultiplier?, fee?, memo? }` on txs (fee wins over gasMultiplier), threaded everywhere (fixes the §5.8 byte-equivalence regression) · **P0** |

## B. Canonical types (over manifestjs, never re-declared)

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | Manifest/deploy/`ServiceConfig` | 🟠 | `ServiceConfig`+`DeployAppInput` → `fred/src/tools/deployApp.ts`; `SkuSelector`+`DeployAppResult`+`DeployManifestInput` → `deployManifest.ts`; `BuildManifestOptions`/`ManifestFormat`/`ManifestValidationResult` → `manifest.ts`; preview input → `tools/buildManifestPreview.ts` | Relocate to **`core/src/manifest-types.ts`** (single chokepoint, **type-only** re-exports); `fred`+`agent-core` derive · **P0** |
| ☐ | `SkuIntent` (byName \| resolved) | 🟠 | modeled 3×: `core/sku-resolution.ts` `ResolveSkuInput`, `fred/deployManifest.ts:72` `SkuSelector`, agent-core loose fields | Define once in core; reuse everywhere · **P0** |
| ☐ | `PortConfig` (`{ host_port?; ingress? }`) | 🔴 | **does not exist** (today: `ServiceConfig.ports: Record<string,Record<string,never>>` + flat `port: number`) | **Net-new** canonical type carrying the ENG-282 shape · **P0** |
| ☐ | manifestjs protobuf types (Lease/SKU/Coin/Credit) | ✅ | re-exported in `core/src/types.ts` | Keep, **type-only**, via the chokepoint; **CI guard** against re-declaration · **P0** |
| ☐ | **Branded domain types — scoped set** (`Address`/`Tenant`, `LeaseUuid`/`ProviderUuid`/`SkuUuid`, `Fqdn`) + uniform `parse*` | 🔴 | none — bare `string` everywhere today | New `core/src/brands.ts`; brand only the confusable/security-relevant ids (the Cosmos ecosystem uses bare `string`, so `tierName`/`denom`/`chainId` stay plain `string`); thread brands through typed sigs where kept; stringly face = parse boundary · **P0a** |

## C. Reads (queries)

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | Raw typed reads | ✅ | manifestjs query client | Hand consumers configured `ctx.query` · **P0** |
| ☐ | Per-module query handlers (bank/billing/sku/…) | 🟡 | `core/src/queries/*.ts` — stringly via dispatcher | Surface typed Face-B for value-added ones · **P0** |
| ☐ | `getBalance` (+runway) / `getAccountInfo` | 🟡 | `core/src/tools/getBalance.ts`; chain server `get_account_info` | ctx-ify; add `getAccountInfo` typed wrapper · **P0** |
| ☐ | Typed lease/credit reads — **P0a spine** (by-tenant, getLease, withdrawable, credit-estimate/-address, getBillingParams) | 🟡/🟠 | **exist as lease-server stringly tools** (`packages/lease/src/index.ts`: get_skus/get_providers/leases_by_tenant/lease_by_custom_domain) over `core/queries/billing.ts` handlers **+ typed in `barney/src/api/billing.ts`** | **Unify** into one typed core fn each (reuse handler + add filters/pagination); NOT port-from-Barney. Add the omitted `getCreditEstimate`/`getCreditAddress` · **P0a** |
| ☐ | **[P0b]** anticipatory lease/provider reads (by-provider/by-sku, `getProviderWithdrawable`, getAllLeases/getAllCredits) | 🟠 | same handlers; **no live consumer** | Land incrementally when a provider/dashboard needs them (rule of three) — **not** in the acceptance spine · **P0b** |
| ☐ | `paginateAll(ctx, pageFn, { maxPages })` | 🔴 | **none** — handlers do single-page + return `hasMore`/`nextKey` | Net-new exhaustion helper (rate-limit-aware, capped); `getAll*` compose it · **P0** |
| ☐ | **Custom-domain reads** (read side of `setItemCustomDomain`): `getLeaseItemsForLease`/`getDomainAssignments`/`getDomainForService`/`getDomainCount` + `getReservedDomainSuffixes` | 🟠 | **only in Barney** (`leaseItems.ts`/`leaseDomains.ts`/`billingParams.ts`); live consumers | Pure helpers over `Lease.items` + the reserved-suffix param projection (for client-side FQDN pre-validation `parseFqdn` defers to chain) · **P0** |
| ☐ | `getAllBalances` (all denoms) + `getProvider(uuid)`/`getSKU(uuid)` singles | 🟠 | only in Barney (`bank.ts`/`sku.ts`) | Trivial wrappers alongside the plurals · **P0** |
| ☐ | `cosmosQuery` (stringly/LLM face) | ✅ | `core/src/cosmos.ts` | Keep as MCP/LLM face · **P0** |

## D. Catalog / SKU / pricing

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | `browseCatalog` (providers+health+skus) | ✅ | `fred/src/tools/browseCatalog.ts` | Canonical; **stays in fred** (provider HTTP); re-exported · **P0** |
| ☐ | `resolveSku` / `listSkuCandidates` | ✅ | `core/src/sku-resolution.ts` | Canonical; no change · **P0** |
| ☐ | `selectCheapest` / `normalizeHourlyPrice` / tier-spec join | 🔴 | **only `barney/src/api/skuTiers.ts`** | Port to core as **PURE** fns over fetched data (no HTTP); accept memoized customizable `SkuSpecSource((ctx)=>…)`; display stays consumer-side · **P0** |
| ☐ | Typed SKU/provider reads (getProviders/getSKUs/byProvider/params) | 🟡/🟠 | lease-server stringly (get_skus/get_providers) + **`barney/src/api/sku.ts`** typed | Unify into typed core fns · **P0** |

## E. Transactions

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | Typed tx: `fundCredits`/`setItemCustomDomain`/`stopApp` | ✅ | `core/src/tools/*.ts` | ctx-ify + thread `TxCallOptions`. `setItemCustomDomain` clear via **discriminated `{ clear: true }`** (not `""`). **`stopApp` IS close-lease** (one fn) · **P0** |
| ☑ | **`executeTx` multi-message** + **per-signer broadcast serialization** — **landed in 4d** | 🔴 | none — every handler returns `{messages:[msg]}`; zero sequence/mutex handling in core | One atomic tx with N messages (cosmjs `signAndBroadcast` takes `EncodeObject[]`); async mutex/queue keyed by signer address in `CosmosClientManager` so one account never races 2 txs in a block — replaces Barney's signing mutex · **P0** |
| | ↳ **N10 residual mutex gap** | 🟠 | `packages/cosmwasm/src/index.ts:253` broadcasts via a direct `signingClient.signAndBroadcast`, bypassing BOTH `cosmosTx` and `executeTx`, so it is NOT serialized by the per-signer mutex | Out of scope for 4d (Q5 = core/fred; cosmwasm is a separate server/process today), but the "one account never races two txs" guarantee has this documented hole — track for the cosmwasm ctx-ification follow-on · **follow-on** |
| ☐ | `cosmosTx` + `cosmosEstimateFee` (stringly face) | ✅ | `core/src/cosmos.ts` | Keep · **P0** |
| ☐ | Per-module tx composers | 🟡 | `core/src/transactions/*.ts` — stringly-only (14 defined, 12 re-exported) | Typed Face-B where value-added; else `cosmosTx`/manifestjs · **P0/P2** |
| ☐ | Faucet helper (drip + verify) | 🟡 | chain pkg `requestFaucet`; **Barney reinvents** `src/api/faucet.ts` `faucetDripAndVerify` | Surface a faucet building block · **P0** |

## F. Fred provider ops

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | deploy/build/restart/update/logs/status/upload | ✅ | `fred/src/tools/*`, `http/*` — Barney reuses | re-export; ctx-ify positional DI · **P2** (functionally done) |
| ☐ | **Diagnostics/connection reads** (gap): `getLeaseConnectionInfo` (live app URL), `getLeaseProvision`/`getLeaseReleases`/`getLeaseInfo` + `validateManifest`/`buildManifestPreview`/`checkDeploymentReadiness` | 🟡 | exist in `fred` (`http/{fred,provider}.ts`, `manifest.ts`, `tools/`) — back `app_diagnostics`/`app_releases`/`build_manifest_preview`/`check_deployment_readiness`; **were dropped from the spec** | Re-export via SDK (the read side a deploy/dashboard consumer needs; `getLeaseConnectionInfo` = "where is my app running") · **P0** |
| ☐ | `pollLeaseUntilReady` (provision_status gating) | ✅ | `fred/src/http/fred.ts` | None · — |

## G. Orchestration (agent-core)

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | deploy/manage/troubleshoot/close engine + recovery | ✅ | `agent-core/src/*.ts` | Keep · — |
| ☐ | **`DeploySpec` fidelity** | 🔴 | `agent-core/src/types.ts` narrow; `internals/build-fred-input.ts` lossy | `Omit<DeployAppInput,…> & {orchestrationHints}` superset; **delete build-fred-input** · **P1 (the one real refactor)** |
| ☐ | Callback contract (output port) | ✅ | `agent-core/src/types.ts` | Add explicit timeout/abort semantics to the type · **P1** |
| ☐ | Saga durability (idempotency + reconcile-on-resume) | 🔴 | in-memory `RecoveryContext` in `deploy-app.ts` | Idempotency key + reconcile-on-resume · **P4 (deferred)** |

## H. Packaging, proof, docs, guards

| ☐ | Block | St | Today | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | SDK package — barrel **+ scoped subpaths** + `…/node` + `sideEffects:false` | 🔴 | none | `@manifest-network/manifest-sdk` (barrel) + `/reads`,`/catalog`,`/deploy`,`/orchestration` + `/node` (`"default": null`) · **P0** |
| ☐ | Example app + acceptance test | 🔴 | none; **existing `e2e/docker-compose` + `deploy-roundtrip` harness unused by the spec** | **e2e against the live chain+provider** (deploy/query/connection/domain/restart/update/logs/batch/subscribe/stop, single+stack) — proves it *deploys*; **plus** a browser build asserting no node builtins + size budget — proves it *bundles*. CI = "done" metric · **P0** |
| ☐ | **Versioning & stability policy** (§14) | 🔴 | lockstep 0.x; zero `@public`/`@beta`/`@internal` markers | Stay lockstep + 0.x; TSDoc release-tag **conventions** (`@public`/`@beta`/`@internal`) + plain `@beta` on `EventTransport` + hand-curated barrel review (**Microsoft API Extractor `.api.md`/release-tag enforcement DEFERRED** to external-publish/1.0); `@deprecated` ≥1-minor grace; defer 1.0 until `EventTransport` graduates · **P0a** |
| ☐ | **`@manifest-network/manifest-sdk-react`** (shared hooks) | 🔴 | none | TanStack-Query hooks (`useLeases`/`useDeploy`/`useLeaseStatus`/`useCatalog`) over the core (wagmi `@wagmi/core`→`wagmi` shape) so Barney + dashboards share them · **later phase** (after core surface stabilizes) |
| ☐ | Cross-face equivalence test | 🔴 | none | Same input via stringly + typed → equivalent (pins single-handler invariant) · **P0** |
| ☐ | Boundary + DAG guard | 🔴 | none (ENG-281/287 are ad-hoc) | `dependency-cruiser`: chokepoint-only manifestjs imports, no 2nd LCD client, whole DAG `edge→agent-core→core→manifestjs`; **meta-test**; **NOT** a grep for type re-declaration (use tsc+single-source) · **P0** |
| ☐ | `publint` + `attw` (exports/.d.ts validation) | 🔴 | none | CI-only (tsdown) · **P0** |
| ☐ | SDK author guide + manifestjs-boundary rule | 🔴 | README/ARCH describe MCP servers; SECURITY/CONTRIBUTING stale | Write SDK guide + per-block reference · **P0+** |
| ☐ | MCP servers → thin typed-API callers | 🟡 | chain/lease/fred/cosmwasm/agent register tools directly | Refactor; gated by **behavioral `*.test.ts` + annotation matrix + JSON snapshot** (byte-equivalent) · **P0/P2** |
| ☑ | **Live status — `subscribeLeaseStatus`** (viem `watch*`-shape: callback + idempotent sync unsubscribe + AbortSignal) — **landed in 4d** | 🟡 | poll exists (`pollLeaseUntilReady`); no subscribe surface | Ship the **surface in P0, poll-backed**; ctx slice **includes `signer`** (mints the Fred lease-data auth token via `createAuthTokens(requireAuthSigner(ctx))` like `appStatus`); **parse each emit** into branded `FredLeaseStatus` before `onData`; typed-face only (NOT MCP/stringly); lives in `fred` · **P0** |
| ☐ | Live-status **WS transport** (`ctx.events?` factory) | 🔴 | **zero WS/streaming in mono**; provider WS only in Barney (`connectLeaseEvents`) | **Deferred** to a named phase: injected WS factory (mirror fetch seam) behind `…/node` (`"default": null`); **WS-SSRF guard** (reuse `ipaddr.js` unicast check); `ws` exact-pinned optionalDep; Barney's WS becomes this transport — no surface churn · **deferred** |

---

## Critical path (corrected)

**P0 (surface: ctx + bound `ManifestClient` + scoped brands + typed reads + catalog/SKU/pricing + SDK pkg) → example-app acceptance test passes = the SDK foundation exists.** P0 is split: **P0a** is the acceptance-test spine (gated on the e2e — the single tracked metric); **P0b** is the anticipatory surface (the 5 no-live-consumer reads, non-exercised `paginateAll`/pricing) that lands incrementally and is **not** gated on the metric. The acceptance test exercises the **capability deploy path** (`resolveSku → buildManifest → deployManifest`), which needs nothing from `agent-core`/P1 — so it is a **P0a** deliverable, not gated behind P1. **P1** (`DeploySpec` superset) hardens the **orchestrated** path separately. P2 (full ctx convergence) and P3 (Barney deletes `src/api/` + the 2,845-line `compositeTransactions.ts`) are mechanical follow-through. P4 (saga durability) is deferred.
