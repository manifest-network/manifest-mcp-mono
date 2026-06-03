# ENG-280 — Split `deployApp` into a build step + a `deployManifest` apply primitive

- **Issue:** [ENG-280](https://linear.app/liftedinit/issue/ENG-280)
- **Date:** 2026-06-03
- **Status:** Design — pending approval
- **Package:** `packages/fred`
- **Related:** unblocks [ENG-279](https://linear.app/liftedinit/issue/ENG-279) (Barney migration); carries [ENG-258](https://linear.app/liftedinit/issue/ENG-258) fixes #1 + #2; pairs with [ENG-282](https://linear.app/liftedinit/issue/ENG-282) (typed-object overload, deferred)

## 1. Problem

`fred`'s `deployApp(input: DeployAppInput)` couples two responsibilities in one call:

1. **Build** — turn typed fields (`image`/`port`/`env`/… or a `{services}` map) into a manifest JSON string.
2. **Apply** — resolve SKU → provider, create an on-chain lease (spends money, irreversible), optionally set a custom domain, upload the manifest to the provider, and poll until ready.

Barney (ENG-279) needs to: build the manifest via the mono (single source of truth), let the user **edit** it in a confirmation dialog, sometimes deploy a **user-supplied** manifest, preserve full manifest fidelity (multi-port, `host_port`, `ingress`), and keep **zero** manifest-construction or orchestration logic locally. The coupling makes that impossible — there is no way to hand `fred` a pre-built manifest.

## 2. Goals / Non-goals

**Goals**

- Extract the apply half into a named `deployManifest` primitive that accepts a **pre-built manifest string** and validates it at the boundary before any chain tx.
- Re-express `deployApp` as a thin wrapper over build + `deployManifest`, with its public signature and behaviour **unchanged** (backward compatible).
- Land [ENG-258](https://linear.app/liftedinit/issue/ENG-258) **#1** (pre-resolved SKU bypass) and **#2** (storage resolved against the same provider as compute) in the same change.

**Non-goals (explicitly deferred)**

- A typed-object (`Manifest`) overload for `deployManifest` — string only for now (round-trips losslessly incl. `host_port`/`ingress`). When it lands later it must be **another thin builder that serializes to a string and calls the same `deployManifest`**, so the string stays the single canonical apply interface.
- The TS↔Go manifest type alignment (ENG-282).
- Any change to the MCP `deploy_app` tool's wire schema.

## 3. Design

### 3.1 New primitive: `deployManifest`

```ts
interface DeployDeps {
  clientManager: CosmosClientManager;
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>;
  getLeaseDataAuthToken: (
    address: string,
    leaseUuid: string,
    metaHash: string,
  ) => Promise<string>;
  fetchFn?: typeof globalThis.fetch;
}

type SkuSelector =
  | { kind: 'byName'; size: string }
  | { kind: 'resolved'; skuUuid: string; providerUuid: string };

interface DeployManifestInput {
  /** Pre-built, serialized manifest JSON. Single-service `{image,ports,…}` or
   *  stack `{services:{…}}`. VALIDATED at the boundary before any chain tx.
   *  The exact bytes handed in are hashed for `meta_hash` and uploaded — they
   *  are parsed only to inspect, never re-serialized (see §3.1 step 4). */
  manifest: string;
  sku: SkuSelector;
  storage?: string;          // storage SKU tier name (resolved against the SAME provider — #2)
  customDomain?: string;
  serviceName?: string;
  gasMultiplier?: number;
  onLeaseCreated?: (leaseUuid: string, providerUrl: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
  pollOptions?: Omit<PollOptions, 'abortSignal'>;
}

function deployManifest(
  deps: DeployDeps,
  input: DeployManifestInput,
): Promise<DeployAppResult>; // DeployAppResult unchanged
```

**Behaviour** (lifted from today's `deployApp.ts` orchestration half, with the manifest-build branch removed):

1. **Parse once, at the boundary, before any tx.** `JSON.parse` the manifest string a single time into `manifestObj` (reusing the object-guard pattern already in `buildManifestPreview`/`parseStackManifest`). Run the existing `validateManifest(manifestObj)`; since it **returns `{ valid, errors }` (it does not throw)**, explicitly convert `valid: false` into `throw ManifestMCPError(INVALID_CONFIG, errors.join('; '))`. Rejecting here — *before* create-lease — is the load-bearing part of the split: it gives every direct caller the same orphaned-lease protection the wrapper has today.
2. **Derive shape from the parsed manifest, not typed fields.** `isStackManifest(manifestObj)` → `getServiceNames(manifestObj)` for stack service names. No `image`/`services` typed inputs.
3. **`serviceName`/`customDomain` coherence (manifest-derived).** If `customDomain` set: trim/non-empty check; stack → `serviceName` required and must be one of `getServiceNames(manifestObj)`; single-service → `serviceName` must be absent. `serviceName` without `customDomain` is rejected. These live here (not only the wrapper) so direct callers are protected.
4. **Meta-hash the ORIGINAL string.** `metaHashHex(input.manifest)` over the exact input bytes (never a re-serialized object — re-serialization would change whitespace/key order and break the `meta_hash == uploaded-body-hash` invariant).
5. **SKU resolution.** `switch (input.sku.kind)`:
   - `'resolved'` → use `skuUuid` + `providerUuid` directly; **skip** `findSkuUuid` (#1).
   - `'byName'` → `{ skuUuid, providerUuid } = findSkuUuid(queryClient, sku.size)`.
6. **Storage (same provider — #2).** If `storage`, `findSkuUuid(queryClient, storage, providerUuid)` pinned to the compute provider; append `${storageSkuUuid}:1` to lease items.
7. **Lease items.** stack → `serviceNames.map(n => \`${skuUuid}:1:${n}\`)`; single → `[\`${skuUuid}:1\`]`; + storage item if any.
8. **Provider URL.** `resolveProviderUrl(queryClient, providerUuid)`.
9. create-lease (`--meta-hash`, metaHash, …leaseItems) → `extractLeaseUuid`.
10. `await onLeaseCreated?.(leaseUuid, providerUrl)`.
11. `try { set-custom-domain (if any) → uploadLeaseData(original bytes) → pollLeaseUntilReady } catch { partial-success wrap }` — identical to today.
12. connection info (best-effort) → `DeployAppResult`.

### 3.2 `deployApp` becomes a thin wrapper

`deployApp` keeps its **exact** public signature `(clientManager, getAuthToken, getLeaseDataAuthToken, input: DeployAppInput, fetchFn?)` and `DeployAppInput` (incl. `size: string`) **unchanged**. It:

1. Runs only the **typed-input** checks that can't be derived from a manifest string: `image` XOR `services`, and `port` required with `image`.
2. Builds the manifest string via the existing `buildManifest`/`buildStackManifest` branches (moved behind it untouched).
3. Constructs `deps = { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn }` and `input = { manifest, sku: { kind: 'byName', size: input.size }, storage, customDomain, serviceName, gasMultiplier, onLeaseCreated, abortSignal, pollOptions }`, then `return deployManifest(deps, input)`.

Existing callers (`register-tools.ts`, `agent-core/deploy-app.ts`) and the MCP `deploy_app` tool are unaffected. `DeployAppInput` does **not** gain `skuUuid`/`providerUuid`; pre-resolution is a `deployManifest`-only (library) feature that Barney uses with `{ kind: 'resolved', … }`.

### 3.3 `findSkuUuid` change (ENG-258 #2)

```ts
function findSkuUuid(
  queryClient: ManifestQueryClient,
  size: string,
  providerUuid?: string, // when set, the matched SKU MUST belong to this provider
): Promise<{ skuUuid: string; providerUuid: string }>;
```

- The not-found error must be **provider-aware**: distinguish "tier `X` is not offered by provider `<providerUuid>` (the provider selected for compute tier `<size>`); tiers from this provider: …" from "tier `X` not found on any provider". The current message lists every provider's tiers, which would be misleading once filtered.
- This error is a **permanent / business validation** error (it is thrown *before* create-lease, so no orphaned lease) and must be classified non-transient so `retry.ts` does not retry it.

### 3.4 Exports

`deployManifest`, `DeployManifestInput`, `SkuSelector`, and `DeployDeps` are added to `packages/fred/src/index.ts` (the package **barrel**). Verified: `deployManifest`'s entire dependency surface (`manifest.ts` parse/validate/`metaHashHex`, `http/provider.ts`, `http/fred.ts`, `cosmosTx`) has **zero** `node:`/`undici` imports — it is pure isomorphic orchestration, so ENG-281's subpath rationale does **not** apply; the barrel stays browser-safe.

## 4. Error handling

- All failures throw `ManifestMCPError` (the codebase convention) — never a `Result`. `DeployAppResult` stays success-only.
- Boundary validation (manifest parse/validate, SKU/provider/serviceName checks) throws `INVALID_CONFIG`/`QUERY_FAILED` **before** create-lease.
- The post-lease `try/catch` partial-success wrap ("Deploy partially succeeded: lease X created…") is unchanged and still classifies `TerminalChainStateError` specially.

## 5. Idioms & rationale (research-grounded)

- **Build/apply separation; the artifact is the interface; all-in-one is sugar** — the dominant idiom across kubectl create/apply, Terraform plan/apply, Nomad `POST /v1/jobs` + `/v1/jobs/parse`, and Podman `SpecGenerator` (issue #14239: "the API must be specgen… lesson learned" — convenience flags client-side, full spec canonical). Validation belongs in the **primitive**, so every caller is protected.
- **String artifact + "parse, don't validate" at the boundary** — the string is the serialized wire/upload artifact, round-trips losslessly (incl. fields the TS types don't model yet), and is what user editors emit; parse it into a validated form *before* the data is "acted upon" (the money-spending tx). K8s dynamic/unstructured client is the precedent; a typed overload can come later without forking the apply path.
- **`SkuSelector` discriminated union (make illegal states unrepresentable)** — `skuUuid` + `providerUuid` must travel together (they come from one SKU record; `providerUuid` drives both `resolveProviderUrl` and same-provider storage). Two bare optionals admit invalid partials (only-sku / only-provider); a tagged union makes them unrepresentable at compile time with exhaustive narrowing (*Effective TypeScript* Item 29; "make illegal states unrepresentable"). `size` folds into the `byName` arm because it is consumed **only** by `findSkuUuid` (not in lease items or the result), so the `resolved` arm needs no `size`.
- **Same-provider storage invariant (#2)** — binding the dependent resource to the primary's topology is the established cloud invariant (AWS EBS: no cross-AZ attach; K8s topology-aware provisioning resolves the pod first, then the volume into the same topology, and leaves it unschedulable rather than violating the constraint). A separate `storageProviderUuid` would let a caller express a state the single-provider lease cannot represent — rejected. Hard-fail, not silent.
- **`deps` object over positional params** — the two auth callbacks are structurally identical `Promise`-returning functions; positional, they are silently transposable, surfacing only as an auth failure *after* a lease exists (an orphaned lease). Named keys eliminate that. 3+ params (esp. same-typed) → options/deps object is the consistent guidance, and it matches `agent-core`'s existing `deployApp(spec, callbacks, opts)` shape.

## 6. Backward compatibility

- `deployApp` signature, `DeployAppInput`, `DeployAppResult`, and the MCP `deploy_app` tool schema are **unchanged**.
- `findSkuUuid` gains an **optional** third parameter — existing call sites compile unchanged.
- New public exports are additive.

## 7. Testing plan (TDD)

New `deployManifest` suite:
- Boundary validation: malformed JSON, `validateManifest` failure → throws `INVALID_CONFIG` **before** any tx (assert no create-lease).
- Shape from manifest: single vs stack derived from the parsed manifest; `serviceName` coherence (stack requires a matching service; single rejects `serviceName`; `serviceName` without `customDomain` rejected).
- Meta-hash is over the **original** bytes (a manifest with non-canonical whitespace still hashes/uploads verbatim).
- ENG-258 #1: `{ kind: 'resolved' }` skips `findSkuUuid` (assert no SKU query); `{ kind: 'byName' }` resolves.
- ENG-258 #2: storage resolved against the compute provider; storage-tier-on-different-provider → provider-aware throw; classified non-transient.
- Partial-success wrap, `onLeaseCreated`, `abortSignal` behaviour (ported from the current `deployApp` tests).

`deployApp.test.ts` (950 lines) stays green as the **backward-compat contract** — manifest-building assertions remain there; the wrapper delegates correctly.

`findSkuUuid` unit tests for the new provider filter (match / no-match-on-provider / absent-everywhere messages).

## 8. Decisions that diverge from the ENG-280 ticket (flagged for review)

Both come from the design-review research; both keep `deployApp` and the MCP tool surface unchanged:

1. **SKU input: `SkuSelector` discriminated union** instead of the ticket's flat `skuUuid?`/`providerUuid?` optionals (illegal-states-unrepresentable; the flat pair admits invalid partials).
2. **`deployManifest(deps, input)` deps object** instead of the ticket's mirrored 5-positional signature (removes the transposable-identical-callbacks footgun).

If either is rejected on review, the fallbacks are: (1) flat optionals + an eager runtime XOR guard inside `deployManifest`; (2) mirror the 5-positional signature with an order-sensitivity comment + test.

## 9. Out of scope / follow-ups

- ENG-282 typed-object overload (additive; serialize→string→same primitive).
- `agent-core`'s own barrel re-exporting `createGuardedFetch` (noted in ENG-281; separate).
