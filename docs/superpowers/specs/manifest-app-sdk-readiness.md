# Manifest App SDK — Readiness Scorecard (living tracker)

- **Repo:** manifest-mcp-mono @ v0.14.0
- **Created:** 2026-06-10 · **Revised:** 2026-06-10 (v3 — post verification + streaming-idiom research + branded-type-safety directive)
- **Pairs with:** `2026-06-10-manifest-app-sdk-foundation-design.md` (Phase 0 spec)
- **Definition of done (single tracked metric):** an in-repo example app builds a deploy-and-query flow composing **only** `@manifest-network/manifest-sdk` + `manifestjs` — zero hand-rolled client, queries, auth, pricing, or orchestration.

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
| ☐ | `CapabilityCtx` / `QueryCtx` (single DI seam) | 🔴 | none — two positional conventions (`clientManager`-first vs `queryClient`-first) | Define `{ chain, query, signer?, fetch }`; **overloaded** factory → `QueryCtx` (no signer) vs `CapabilityCtx`; reads typed against `Pick<…,'query'\|'chain'>` (ISP) · **P0** (full convergence **P2**) |
| ☐ | Signer port | 🟡 | `core/src/types.ts` `WalletProvider` (signArbitrary OPTIONAL) | **Type-split** `TxSigner` / `AuthSigner = TxSigner & { signArbitrary }` + `requireAuthSigner(ctx)` guard; `getSigner` returns @manifest-network/stargate `OfflineSigner` · **P0** |
| ☐ | ADR-036 auth-token factory | 🟡 | `fred/src/http/auth-token-service.ts`, `auth.ts` (Barney: `src/ai/toolExecutor/fredAuth.ts` `makeFredAuthTokens`) | Expose `createAuthTokens(signer: AuthSigner, { chainId })`, **lazily cached / re-sign on expiry**; kill per-call closures · **P0** |
| ☐ | fetch port | ✅ | `fred/src/server/fetch-gate.ts`, core `…/guarded-fetch` subpath (`"default": null` guard) | Move onto ctx · **P0** |

## B. Canonical types (over manifestjs, never re-declared)

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | Manifest/deploy/`ServiceConfig` | 🟠 | `ServiceConfig`+`DeployAppInput` → `fred/src/tools/deployApp.ts`; `SkuSelector`+`DeployAppResult`+`DeployManifestInput` → `deployManifest.ts`; `BuildManifestOptions`/`ManifestFormat`/`ManifestValidationResult` → `manifest.ts`; preview input → `tools/buildManifestPreview.ts` | Relocate to **`core/src/manifest-types.ts`** (single chokepoint, **type-only** re-exports); `fred`+`agent-core` derive · **P0** |
| ☐ | `SkuIntent` (byName \| resolved) | 🟠 | modeled 3×: `core/sku-resolution.ts` `ResolveSkuInput`, `fred/deployManifest.ts:72` `SkuSelector`, agent-core loose fields | Define once in core; reuse everywhere · **P0** |
| ☐ | `PortConfig` (`{ host_port?; ingress? }`) | 🔴 | **does not exist** (today: `ServiceConfig.ports: Record<string,Record<string,never>>` + flat `port: number`) | **Net-new** canonical type carrying the ENG-282 shape · **P0** |
| ☐ | manifestjs protobuf types (Lease/SKU/Coin/Credit) | ✅ | re-exported in `core/src/types.ts` | Keep, **type-only**, via the chokepoint; **CI guard** against re-declaration · **P0** |
| ☐ | **Branded domain types** (`Address`/`Tenant`/`LeaseUuid`/`ProviderUuid`/`SkuUuid`/`TierName`/`Fqdn`/`Denom`/`ChainId`) + `parse*`/`as*` | 🔴 | none — bare `string` everywhere today | New `core/src/brands.ts`; thread through every typed signature (no bare `string` on the typed face); stringly face = parse boundary; viem `Address`/`Hex` idiom · **P0** |

## C. Reads (queries)

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | Raw typed reads | ✅ | manifestjs query client | Hand consumers configured `ctx.query` · **P0** |
| ☐ | Per-module query handlers (bank/billing/sku/…) | 🟡 | `core/src/queries/*.ts` — stringly via dispatcher | Surface typed Face-B for value-added ones · **P0** |
| ☐ | `getBalance` (+runway) / `getAccountInfo` | 🟡 | `core/src/tools/getBalance.ts`; chain server `get_account_info` | ctx-ify; add `getAccountInfo` typed wrapper · **P0** |
| ☐ | Typed lease/credit reads (by-tenant/provider/sku, getLease, **getProviderWithdrawable**, withdrawable, credit-estimate/-address, getAllLeases/Credits, getBillingParams) | 🟡/🟠 | **exist as lease-server stringly tools** (`packages/lease/src/index.ts`: get_skus/get_providers/leases_by_tenant/lease_by_custom_domain) over `core/queries/billing.ts` handlers **+ typed in `barney/src/api/billing.ts`** | **Unify** into one typed core fn each (reuse handler + add filters/pagination); NOT port-from-Barney. Add the omitted `getProviderWithdrawable`/`getCreditEstimate`/`getCreditAddress` · **P0** |
| ☐ | `paginateAll(ctx, pageFn, { maxPages })` | 🔴 | **none** — handlers do single-page + return `hasMore`/`nextKey` | Net-new exhaustion helper (rate-limit-aware, capped); `getAll*` compose it · **P0** |
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
| ☐ | Typed tx: `fundCredits`/`setItemCustomDomain`/`stopApp` | ✅ | `core/src/tools/*.ts` | ctx-ify. **`setItemCustomDomain` with `customDomain:""` = clear** (only domain write). **`stopApp` IS close-lease** (one fn, not two) · **P0** |
| ☐ | `cosmosTx` + `cosmosEstimateFee` (stringly face) | ✅ | `core/src/cosmos.ts` | Keep · **P0** |
| ☐ | Per-module tx composers | 🟡 | `core/src/transactions/*.ts` — stringly-only (14 defined, 12 re-exported) | Typed Face-B where value-added; else `cosmosTx`/manifestjs · **P0/P2** |
| ☐ | Faucet helper (drip + verify) | 🟡 | chain pkg `requestFaucet`; **Barney reinvents** `src/api/faucet.ts` `faucetDripAndVerify` | Surface a faucet building block · **P0** |

## F. Fred provider ops

| ☐ | Block | St | Today (file) | Delta → target · Phase |
|---|---|---|---|---|
| ☐ | deploy/build/validate/restart/update/logs/status/upload/releases | ✅ | `fred/src/tools/*`, `http/*` — Barney reuses | ctx-ify the ad-hoc positional DI · **P2** (functionally done) |
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
| ☐ | Example app + acceptance test | 🔴 | none | Browser build; **assert no node builtins** in chunk + **size budget** (size-limit/bundlewatch); CI = "done" metric (P0 capability path) · **P0** |
| ☐ | Cross-face equivalence test | 🔴 | none | Same input via stringly + typed → equivalent (pins single-handler invariant) · **P0** |
| ☐ | Boundary + DAG guard | 🔴 | none (ENG-281/287 are ad-hoc) | `dependency-cruiser`: chokepoint-only manifestjs imports, no 2nd LCD client, whole DAG `edge→agent-core→core→manifestjs`; **meta-test**; **NOT** a grep for type re-declaration (use tsc+single-source) · **P0** |
| ☐ | `publint` + `attw` (exports/.d.ts validation) | 🔴 | none | CI-only (tsdown) · **P0** |
| ☐ | SDK author guide + manifestjs-boundary rule | 🔴 | README/ARCH describe MCP servers; SECURITY/CONTRIBUTING stale | Write SDK guide + per-block reference · **P0+** |
| ☐ | MCP servers → thin typed-API callers | 🟡 | chain/lease/fred/cosmwasm/agent register tools directly | Refactor; gated by **behavioral `*.test.ts` + annotation matrix + JSON snapshot** (byte-equivalent) · **P0/P2** |
| ☐ | **Live status — `subscribeLeaseStatus`** (viem `watch*`-shape: callback + sync unsubscribe + AbortSignal) | 🟡 | poll exists (`pollLeaseUntilReady`); no subscribe surface | Ship the **surface in P0, poll-backed**; `onData` emits the same `FredLeaseStatus`; typed-face only (NOT MCP/stringly); lives in `fred` · **P0** |
| ☐ | Live-status **WS transport** (`ctx.events?` factory) | 🔴 | **zero WS/streaming in mono**; provider WS only in Barney (`connectLeaseEvents`) | **Deferred** to a named phase: injected WS factory (mirror fetch seam) behind `…/node` (`"default": null`); **WS-SSRF guard** (reuse `ipaddr.js` unicast check); `ws` exact-pinned optionalDep; Barney's WS becomes this transport — no surface churn · **deferred** |

---

## Critical path (corrected)

**P0 (surface: ctx + types + typed reads + catalog/SKU/pricing + SDK pkg) → example-app acceptance test passes = the SDK foundation exists.** The acceptance test exercises the **capability deploy path** (`resolveSku → buildManifest → deployManifest`), which needs nothing from `agent-core`/P1 — so it is a **P0** deliverable, not gated behind P1. **P1** (`DeploySpec` superset) hardens the **orchestrated** path separately. P2 (full ctx convergence) and P3 (Barney deletes `src/api/` + the 2,845-line `compositeTransactions.ts`) are mechanical follow-through. P4 (saga durability) is deferred.
