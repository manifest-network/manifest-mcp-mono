# ENG-280 — Split `deployApp` into a build step + a `deployManifest` apply primitive

- **Issue:** [ENG-280](https://linear.app/liftedinit/issue/ENG-280)
- **Date:** 2026-06-03
- **Status:** Design v2 — revised per whole-spec best-practices review (pending approval)
- **Package:** `packages/fred` (+ small changes in `packages/core` and `packages/agent-core`)
- **Scope:** **Maximal** — the split + ENG-258 #1/#2 + boundary hardening + observability + structured-error contract & consumer migration + create-lease double-broadcast mitigation. No deferred follow-ups.
- **Related:** unblocks [ENG-279](https://linear.app/liftedinit/issue/ENG-279); pairs with [ENG-282](https://linear.app/liftedinit/issue/ENG-282) (typed-object overload, deferred)

## 1. Problem

`fred`'s `deployApp(input: DeployAppInput)` couples two responsibilities:

1. **Build** — turn typed fields (`image`/`port`/… or a `{services}` map) into a manifest JSON string.
2. **Apply** — resolve SKU → provider, create an on-chain lease (**spends money, irreversible**), optionally set a custom domain, upload the manifest, and poll until ready.

Barney (ENG-279) needs to build the manifest via the mono, let the user **edit** it, sometimes deploy a **user-supplied** manifest, preserve full fidelity (`host_port`/`ingress`), and keep **zero** manifest/orchestration logic locally. The coupling blocks all of that — there is no way to hand `fred` a pre-built manifest. Critically, the new primitive accepts a **partly user-supplied string**, which introduces a trust boundary the typed-field path never had (see §7).

## 2. Goals / Non-goals

**Goals**

- Extract the apply half into `deployManifest`, accepting a **pre-built manifest string**, validating/hardening it at the boundary **before any chain tx**.
- Re-express `deployApp` as a thin wrapper; its public signature, `DeployAppInput`, `DeployAppResult`, and the MCP `deploy_app` tool schema stay **unchanged**.
- Land ENG-258 **#1** and **#2** with explicit acceptance criteria:
  - **#1 acceptance:** given `sku.kind === 'resolved'`, `deployManifest` issues **zero** `sku.v1.sKUs` queries (asserted not-called) and uses the supplied `skuUuid`/`providerUuid` verbatim.
  - **#2 acceptance:** given `storage`, the storage SKU is resolved with `providerUuid` **pinned to the compute provider**; a storage tier offered only by a *different* provider yields a provider-aware `INVALID_CONFIG` **before** create-lease.
- Make the new user-supplied-string boundary safe (§7) and the irreversible money-spend observable (§6) and recoverable (§4, §5).

**Non-goals (deferred)**

- A typed-object (`Manifest`) overload — string only (round-trips losslessly incl. `host_port`/`ingress`). When ENG-282's typed path lands it must be **another thin builder that serializes to a string and calls this same `deployManifest`** — *not* a `manifest: string | Manifest` union, because a typed object has no canonical bytes and a union would break the `meta_hash == uploaded-bytes` invariant (§3.1 step 4).
- TS↔Go manifest type alignment (ENG-282).
- A `DomainTarget` discriminated union for `customDomain`/`serviceName` — see §3.1 note (kept as validated optionals deliberately).

## 3. Design

### 3.1 New primitive: `deployManifest`

Signature is **domain-first, options-last** (matches agent-core's `deployApp(spec, …, opts)` and the "primary param, then options" idiom; the new symbol gets the idiomatic shape rather than inheriting `deployApp`'s legacy 5-positional one). The injected-dependency bag follows the tree-wide exported `*Options` naming convention.

```ts
type SkuSelector =
  | { kind: 'byName'; size: string }
  | { kind: 'resolved'; skuUuid: string; providerUuid: string };

interface DeployManifestInput {
  manifest: string;            // pre-built serialized JSON; hardened+validated at the boundary
  sku: SkuSelector;
  storage?: string;            // storage SKU tier name (resolved against the SAME provider — #2)
  customDomain?: string;
  serviceName?: string;        // see note: kept as validated optionals, not a sub-union
  gasMultiplier?: number;
  onLeaseCreated?: (leaseUuid: string, providerUrl: string) => void | Promise<void>;
  abortSignal?: AbortSignal;
  pollOptions?: Omit<PollOptions, 'abortSignal'>;
}

interface DeployManifestOptions {
  clientManager: CosmosClientManager;
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>;
  getLeaseDataAuthToken: (address: string, leaseUuid: string, metaHash: string) => Promise<string>;
  fetchFn?: typeof globalThis.fetch;
}

function deployManifest(
  input: DeployManifestInput,
  opts: DeployManifestOptions,
): Promise<DeployAppResult>; // DeployAppResult unchanged
```

> **`customDomain`/`serviceName` modeling note.** These are a data clump (serviceName requires customDomain; on a stack it must name a real service). They are deliberately **not** modeled as a sub-union mirroring `SkuSelector`, because the "must match a manifest service" rule is value-dependent (needs the parsed manifest), so a type can't fully capture it — the runtime guard in step 3 is load-bearing regardless. Kept as validated optionals to stay field-parallel with the unchanged `DeployAppInput`. The make-illegal-states lens is applied where it pays off (the SKU selector), and consciously not where it only half-pays.

**Behaviour:**

0. **Boundary hardening (before parse).** Reject a manifest string over a fixed byte cap (DoS guard — `deployManifest` is a public unbounded-string entrypoint). Then **strict-parse**: reject duplicate keys and `__proto__`/`constructor` keys → `throw ManifestMCPError(INVALID_CONFIG, …)`. Rationale: the provider re-parses the *same bytes* in Go; `JSON.parse` is last-wins on duplicate keys, so a duplicate-key manifest could validate locally against one value and deploy another while `meta_hash` matches perfectly (cross-language parser-differential, Bishop Fox). `validateManifest` runs on the already-collapsed object and **cannot** catch this — it must be rejected at parse. Implementation: a small in-repo strict-parse helper (preferred over a new dependency, per the repo's dep-pinning discipline; a dep would need explicit approval).
1. **Validate, before any tx.** Run `validateManifest(parsed)`. It **returns `{ valid, errors, format }`** (it does not throw) — explicitly convert `valid:false` into `throw ManifestMCPError(INVALID_CONFIG, errors.join('; '), { errors })`, carrying the **structured `errors[]` in `details`** (Barney renders field-pathed errors without string-splitting). Rejecting here — before create-lease — is the load-bearing part of the split.
2. **Shape from the parsed manifest (thread, don't re-derive).** Use the `format` (`'stack'|'single'`) returned by step 1; for stack, `getServiceNames(parsed)` once. (Avoids the shotgun-parse of calling `isStackManifest`/`getServiceNames` as a second independent classification.)
3. **`serviceName`/`customDomain` coherence (manifest-derived, in the primitive).** If `customDomain`: trim/non-empty; stack → `serviceName` required and ∈ `getServiceNames(parsed)`; single → `serviceName` absent; `serviceName` without `customDomain` rejected. In the primitive so **direct callers** get the same protection.
4. **Meta-hash the ORIGINAL bytes.** `metaHashHex(input.manifest)` over the exact input string — never a re-serialized object (re-serialization changes whitespace/key order and breaks `meta_hash == uploaded-body-hash`). The same original bytes are uploaded in step 11.
5. **SKU resolution.** `switch (input.sku.kind)` with a `default: never` exhaustiveness guard: `'resolved'` → use `skuUuid`+`providerUuid`, **skip** `findSkuUuid` (#1); `'byName'` → `findSkuUuid(queryClient, sku.size)`.
6. **Storage (same provider — #2).** If `storage`: `findSkuUuid(queryClient, storage, providerUuid)` pinned to the compute provider; append `${storageSkuUuid}:1`.
7. **Lease items.** stack → `serviceNames.map(n => \`${skuUuid}:1:${n}\`)`; single → `[\`${skuUuid}:1\`]`; + storage item.
8. **Provider URL.** `resolveProviderUrl(queryClient, providerUuid)`.
9. **create-lease — the point of no return.** Submitted with the **double-broadcast mitigation** (§4): `maxRetries: 0` so a transient-looking network error after the tx commits is never transparently re-broadcast. → `extractLeaseUuid`.
10. `await onLeaseCreated?.(leaseUuid, providerUrl)` — **outside** the abort-checked try.
11. `try { set-custom-domain (if any) → uploadLeaseData(ORIGINAL bytes) → pollLeaseUntilReady } catch { partial-success wrap (§5) }`.
12. connection info (best-effort) → `DeployAppResult`.

> **Abort-ordering invariant (named).** `abortSignal` MUST NOT be checked between create-lease broadcast (step 9) and lease-UUID extraction; `onLeaseCreated` fires outside the abort-checked try because the lease exists on-chain regardless of abort state. Violating this can orphan a paid lease whose UUID the caller never learns. (Mirrors the rationale inline at `deployApp.ts:371-377`.)

### 3.2 `deployApp` becomes a thin wrapper

Keeps its exact public signature and `DeployAppInput` (incl. `size`). It runs the typed-input checks (`image` XOR `services`; `port` with `image`), builds the manifest string via the existing `buildManifest`/`buildStackManifest` branches, then calls `deployManifest({ manifest, sku: { kind: 'byName', size: input.size }, … }, { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn })`.

> **Latent behaviour change (call out + test).** The wrapper now JSON-parses and runs `validateManifest` over its *own* built manifest, which `buildManifest`/`buildStackManifest` never validated. Add a cross-check + test that builder output **always** passes `validateManifest` (and the strict-parse hardening), so "behaviour unchanged" doesn't hide a new failure mode where a builder-allowed manifest trips the validator.

`DeployAppInput` does **not** gain `skuUuid`/`providerUuid`; pre-resolution is a `deployManifest`-only feature (Barney uses `{ kind: 'resolved' }`). Existing callers and the MCP tool are unaffected.

### 3.3 `findSkuUuid` change (ENG-258 #2)

```ts
function findSkuUuid(
  queryClient, size: string, providerUuid?: string,
): Promise<{ skuUuid: string; providerUuid: string }>;
```

- When `providerUuid` is set, the matched SKU must belong to it; otherwise throw **`INVALID_CONFIG`** (not `QUERY_FAILED` — `INVALID_CONFIG` is in core's `NON_RETRYABLE_ERROR_CODES`; `QUERY_FAILED` is not). Add a test asserting `isRetryableError(err) === false`.
- **Provider-aware message:** distinguish "tier `X` is not offered by provider `<providerUuid>` (selected for compute tier `<size>`); tiers from this provider: …" from "tier `X` not found on any provider". The current message lists every provider's tiers, which would mislead once filtered.

### 3.4 Exports

Public **call-contract** types → `packages/fred/src/index.ts`: `deployManifest`, `DeployManifestInput`, `SkuSelector`, `DeployManifestOptions` (the last is exported only because Barney must type a variable of it). Verified: `deployManifest`'s dependency surface has **zero** `node:`/`undici` imports — pure isomorphic orchestration, so it belongs in the barrel (ENG-281's subpath rationale does not apply).

## 4. Idempotency & retry semantics

`deployManifest` is a **non-idempotent create** (like `kubectl create` / HTTP `POST`), **not** a convergent `apply` (`kubectl apply`/`terraform apply` reconcile to zero changes on re-run). Calling it twice creates two separately-paid leases. The verb "deploy" is chosen over "apply" precisely to avoid implying convergence.

- **Delivery model:** at-least-once over **three** irreversible writes — create-lease tx (step 9), set-item-custom-domain tx (step 11), `uploadLeaseData` (step 11). The create-lease boundary is the point of no return.
- **No blind retry.** After step 9 a paid lease may exist even when the call throws (lost response / crash / abort between broadcast and UUID extraction). Callers MUST NOT blind-retry; recovery = query existing leases (by tenant, or by `meta_hash` — which is a deterministic dedup key over the exact manifest bytes) before re-invoking.
- **Double-broadcast mitigation (in-scope, touches core).** `cosmosTx` wraps the broadcast in `withRetry(clientManager.getConfig().retry)`; a post-commit network error (`fetch failed`/`socket hang up`) is classified transient and would **re-broadcast → double lease**. Fix: add an optional per-call retry override to `cosmosTx`'s `TxOverrides` (e.g. `retry?: { maxRetries: number }`) threaded into the broadcast `withRetry`, and submit create-lease with `maxRetries: 0`. Tradeoff (documented): genuinely-transient *pre-broadcast* setup failures for this one tx are also not retried — acceptable; the caller retries the whole `deployManifest` after the leases-query recovery check. Add a test: a simulated transient broadcast failure on create-lease produces **no second lease**.

## 5. Error handling — structured contract

All failures throw `ManifestMCPError` (codebase convention); `DeployAppResult` stays success-only.

- **Boundary** (hardening, validate, SKU/provider/serviceName) throws `INVALID_CONFIG` **before** create-lease.
- **Post-create-lease failures** carry a machine-readable contract in `details`: `{ partial: true, failedStep: 'set_domain'|'upload'|'poll', lease_uuid, provider_uuid, provider_url }`. The `'Deploy partially succeeded:'` message prefix is kept **byte-stable** (human convenience), but `details.partial` is the discriminant.
- **`TerminalChainStateError`** path also includes `lease_uuid` in its `withContext` (today it carries only `providerUuid`/`providerUrl`), so a paid lease is always identifiable.
- **Consumer migration (in-scope, agent-core).** `agent-core/internals/classify-deploy-error.ts` currently branches on `message.startsWith('Deploy partially succeeded:')`. Migrate it to branch on `details.partial === true` first, **falling back** to the prefix match for back-compat with older fred versions (its docstring already version-references 0.8.0). Keep the existing prefix test; add a `details.partial` test.

## 6. Observability

For an irreversible money-spend, specify logging via core's `logger`, all objects run through `sanitizeForLogging` (manifest body + auth tokens must never hit logs raw; `SENSITIVE_FIELDS` already redacts token/meta fields):

- boundary reject → `logger.warn` with code + sanitized reason (no manifest body).
- immediately **before** create-lease → `logger.info('creating lease', { meta_hash, item_count })`.
- immediately **after** create-lease, on **both** success and the partial-failure catch → `logger.info/warn('lease <uuid> created', { lease_uuid, provider_uuid })` — so an orphaned spend is recorded even if the process dies before return.

## 7. Security — user-supplied-manifest threat model

The manifest is now partly user-supplied/edited (Barney). Threats + mitigations:

- **Injection via service name / storage tier / domain into on-chain args.** Service names flow into lease items `${skuUuid}:1:${name}`. Mitigation: `validateManifest`'s RFC 1123 DNS-label check (`validateServiceName`) runs at step 1 **before** lease-item construction (step 7) — a name with `:`/whitespace can't reach a lease item. **Validate-before-build ordering is load-bearing**; add a regression test that a structurally-malformed service name is rejected at the boundary with **no create-lease**.
- **Cross-language JSON parser differential / duplicate keys** — see §3.1 step 0 (rejected at strict-parse).
- **Prototype pollution** (`__proto__`/`constructor`) — rejected at strict-parse (the parsed object is spread by `mergeManifest`; the existing object-guard doesn't strip these).
- **DoS** — byte cap before parse.

## 8. Backward compatibility

- `deployApp` signature, `DeployAppInput`, `DeployAppResult`, and the MCP `deploy_app` schema unchanged. `findSkuUuid` gains an **optional** 3rd param (existing calls compile unchanged). New exports are additive. The `'Deploy partially succeeded:'` prefix stays byte-stable.
- **Known illegal-states held for compat (noted, not fixed):** `DeployAppResult.connection`/`connectionError` are a mutually-exclusive runtime pair (set in disjoint try/catch branches), as are `custom_domain`/`service_name`; both kept as independent optionals for backward-compat rather than refactored into a discriminated result. The make-illegal-states lens applied to `SkuSelector` is consciously not turned on the frozen result type.

## 9. Testing plan (TDD)

- **No-side-effect, per case.** *Every* boundary case (oversize, dup-key, `__proto__`, malformed JSON, `validateManifest` fail, serviceName/customDomain incoherence, storage-on-wrong-provider, abort-before-create) asserts the mocked `cosmosTx('billing','create-lease', …)` was **never called**.
- **Hash fidelity (property + examples).** Beyond one whitespace case: reordered keys, `\u` escapes, and an assertion that the bytes passed to mocked `uploadLeaseData` equal the input manifest **verbatim** and `metaHashHex` was over those bytes. Ideally a `fast-check` property over valid-but-non-canonical JSON.
- **Anti-over-mocking.** New `deployManifest` tests MUST NOT mock `manifest.ts` (run real parse/validate/`metaHashHex`) and assert **real effects** (lease-items content, uploaded bytes, hash), not just call-counts — to avoid the repo's documented regression-guard-inversion risk.
- **ENG-258 #1/#2** per the §2 acceptance criteria (assert `sKUs` not-called on `resolved`; provider-pinned storage + provider-aware `INVALID_CONFIG`; `isRetryableError === false`).
- **Structured errors / consumer.** partial failure exposes `details.{partial, failedStep, lease_uuid, provider_uuid}`; `TerminalChainStateError` carries `lease_uuid`; `classify-deploy-error.ts` branches on `details.partial` and still handles the legacy prefix; prefix byte-stability test.
- **Double-broadcast.** simulated transient broadcast failure on create-lease → no second lease.
- **Observability.** boundary-reject / pre- / post-create-lease log lines emitted at the stated levels and sanitized.
- **Backward-compat.** `deployApp.test.ts` (950 lines) stays green unchanged; + a wrapper test that builder output always passes `validateManifest`.

## 10. Release / CHANGELOG

- `CHANGELOG.md` `[Unreleased]` → `### Changed`: new public exports (`deployManifest`, `DeployManifestInput`, `SkuSelector`, `DeployManifestOptions`), additive `findSkuUuid` provider param, `cosmosTx` `TxOverrides.retry`; `### Security`: strict-parse boundary hardening (dup-key/`__proto__`/size), create-lease double-broadcast mitigation. Upgrade note: error `details.partial` is now the partial-success discriminant (prefix retained).
- This is the **fred mono release that unblocks ENG-279** (Barney consumes a published version). Note the version bump/publish step.

## 11. Out of scope / follow-ups

- ENG-282 typed-object overload (additive; serialize→string→same primitive).
- `agent-core`'s own barrel re-exporting `createGuardedFetch` (noted in ENG-281; separate).
