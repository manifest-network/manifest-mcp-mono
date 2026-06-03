# ENG-280 — Split `deployApp` into a build step + a `deployManifest` apply primitive

- **Issue:** [ENG-280](https://linear.app/liftedinit/issue/ENG-280)
- **Date:** 2026-06-03
- **Status:** Design v3 — trimmed after a third adversarial review removed two over-builds (pending approval)
- **Package:** `packages/fred` (+ a small consumer change in `packages/agent-core`; **no** `packages/core` change)
- **Scope:** the split + ENG-258 #1/#2 + load-bearing boundary hardening + structured-error contract & consumer migration + observability. The v2 `cosmosTx` retry change and the bespoke JSON tokenizer were **cut** as over-engineered (see §4, §7).
- **Related:** unblocks [ENG-279](https://linear.app/liftedinit/issue/ENG-279); pairs with [ENG-282](https://linear.app/liftedinit/issue/ENG-282) (typed-object overload, deferred)

## 1. Problem

`fred`'s `deployApp(input: DeployAppInput)` couples two responsibilities:

1. **Build** — typed fields (`image`/`port`/… or a `{services}` map) → a manifest JSON string.
2. **Apply** — resolve SKU → provider, create an on-chain lease (**spends money, irreversible**), optionally set a custom domain, upload the manifest, poll until ready.

Barney (ENG-279) needs to build via the mono, let the user **edit** the manifest, sometimes deploy a **user-supplied** one, preserve fidelity (`host_port`/`ingress`), and keep **zero** manifest/orchestration logic locally. The coupling blocks all of it. The new primitive accepts a **partly user-supplied string** — a trust boundary the typed-field path never had (see §7).

## 2. Goals / Non-goals

**Goals**

- Extract the apply half into `deployManifest`, accepting a **pre-built manifest string**, validated at the boundary **before any chain tx**.
- Re-express `deployApp` as a thin wrapper; its public signature, `DeployAppInput`, `DeployAppResult`, and the MCP `deploy_app` schema stay **unchanged** (see §8 for the one internal caveat).
- ENG-258 with explicit acceptance criteria:
  - **#1:** given `sku.kind === 'resolved'`, `deployManifest` issues **zero** `sku.v1.sKUs` queries (asserted not-called) and uses `skuUuid`/`providerUuid` verbatim.
  - **#2:** given `storage`, the storage SKU resolves with `providerUuid` **pinned to the compute provider**; a storage tier offered only by a *different* provider → provider-aware `INVALID_CONFIG` **before** create-lease.

**Non-goals (deferred)**

- A typed-object (`Manifest`) overload — string only. When ENG-282's typed path lands it must be **another thin builder that serializes to a string and calls this same `deployManifest`**, *not* a `manifest: string | Manifest` union (a typed object has no canonical bytes → a union would break the `meta_hash == uploaded-bytes` invariant, §3.1 step 4).
- A `DomainTarget` union for `customDomain`/`serviceName` (kept as validated optionals — §3.1 note).

## 3. Design

### 3.1 New primitive: `deployManifest`

Domain-first, options-last (matches agent-core's `deployApp(spec, …, opts)` and the "primary, then options" idiom); the injected-dependency bag follows the tree-wide exported `*Options` convention.

```ts
type SkuSelector =
  | { kind: 'byName'; size: string }
  | { kind: 'resolved'; skuUuid: string; providerUuid: string };

interface DeployManifestInput {
  manifest: string;            // pre-built serialized JSON; validated at the boundary
  sku: SkuSelector;
  storage?: string;            // resolved against the SAME provider — #2
  customDomain?: string;
  serviceName?: string;        // validated optionals, not a sub-union (see note)
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

> **`customDomain`/`serviceName` note.** A data clump (serviceName requires customDomain; on a stack must name a real service), deliberately **not** a sub-union: the "must match a manifest service" rule is value-dependent (needs the parsed manifest), so a type can't fully capture it and the runtime guard in step 3 is load-bearing regardless. Kept as validated optionals to stay field-parallel with the unchanged `DeployAppInput`.

**Behaviour:**

0. **Size cap, before parse.** Reject a manifest string over a fixed byte cap (DoS guard — `deployManifest` is a public unbounded-string entrypoint). Then `JSON.parse`; reject a top-level **own** `__proto__`/`constructor` key (trivial check, **defense-in-depth** — `deployManifest` never uses the parsed object as a lookup map, so this is belt-and-suspenders, not load-bearing).
1. **Validate, before any tx.** `validateManifest(parsed)` **returns `{ valid, errors, format }`** (it does not throw) — convert `valid:false` into `throw ManifestMCPError(INVALID_CONFIG, errors.join('; '), { errors })`, carrying the **structured `errors[]` in `details`** (Barney renders field-pathed errors without string-splitting). `validateManifest` is extended with a case-folded top-level-key collision check (§7). Rejecting here — before create-lease — is the load-bearing part of the split.
2. **Shape: thread, don't re-derive.** Use the `format` (`'stack'|'single'`) returned by step 1; for stack, `getServiceNames(parsed)` once (avoids a second independent classification).
3. **`serviceName`/`customDomain` coherence (manifest-derived, in the primitive).** If `customDomain`: trim/non-empty; stack → `serviceName` required and ∈ `getServiceNames(parsed)`; single → `serviceName` absent; `serviceName` without `customDomain` rejected. In the primitive so **direct callers** are protected.
4. **Meta-hash the ORIGINAL bytes.** `metaHashHex(input.manifest)` over the exact input string — never a re-serialized object (preserves `meta_hash == uploaded-body-hash`). The same bytes upload in step 11.
5. **SKU resolution.** `switch (input.sku.kind)` + `default: never` guard: `'resolved'` → use the pair, **skip** `findSkuUuid` (#1); `'byName'` → `findSkuUuid(queryClient, sku.size)`.
6. **Storage (same provider — #2).** If `storage`: `findSkuUuid(queryClient, storage, providerUuid)` pinned to the compute provider; append `${storageSkuUuid}:1`.
7. **Lease items.** stack → `serviceNames.map(n => \`${skuUuid}:1:${n}\`)`; single → `[\`${skuUuid}:1\`]`; + storage item.
8. **Provider URL.** `resolveProviderUrl(queryClient, providerUuid)`.
9. **create-lease — the point of no return.** Standard `cosmosTx('billing','create-lease', …)` → `extractLeaseUuid`. (No retry override — the broadcast leg is already non-retryable; see §4.)
10. `await onLeaseCreated?.(leaseUuid, providerUrl)` — **outside** the abort-checked try.
11. `try { set-custom-domain (if any) → uploadLeaseData(ORIGINAL bytes) → pollLeaseUntilReady } catch { partial-success wrap (§5) }`.
12. connection info (best-effort) → `DeployAppResult`.

> **Abort-ordering invariant (named).** `abortSignal` MUST NOT be checked between create-lease broadcast (step 9) and lease-UUID extraction; `onLeaseCreated` fires outside the abort-checked try because the lease exists on-chain regardless of abort state. Violating this orphans a paid lease whose UUID the caller never learns. (Mirrors `deployApp.ts:371-377`.)

### 3.2 `deployApp` becomes a thin wrapper

Keeps its exact public signature and `DeployAppInput` (incl. `size`). Runs the typed-input checks (`image` XOR `services`; `port` with `image`), builds the manifest string via the existing `buildManifest`/`buildStackManifest`, then calls `deployManifest({ manifest, sku: { kind: 'byName', size: input.size }, … }, { clientManager, getAuthToken, getLeaseDataAuthToken, fetchFn })`.

`DeployAppInput` does **not** gain `skuUuid`/`providerUuid`; pre-resolution is `deployManifest`-only (Barney uses `{ kind: 'resolved' }`). Existing callers + the MCP tool are unaffected.

### 3.3 `findSkuUuid` change (ENG-258 #2)

```ts
function findSkuUuid(queryClient, size: string, providerUuid?: string): Promise<{ skuUuid; providerUuid }>;
```

- When `providerUuid` is set, the matched SKU must belong to it; else throw **`INVALID_CONFIG`** (it *is* in `NON_RETRYABLE_ERROR_CODES`; `QUERY_FAILED`, thrown today, is **not**). Test: `isRetryableError(err) === false`.
- **Provider-aware message:** "tier `X` not offered by provider `<providerUuid>` (selected for compute tier `<size>`); tiers from this provider: …" vs "tier `X` not found on any provider".

### 3.4 Exports

Public **call-contract** types → `packages/fred/src/index.ts`: `deployManifest`, `DeployManifestInput`, `SkuSelector`, `DeployManifestOptions` (exported only because Barney types a variable of it). `deployManifest`'s dependency surface is pure isomorphic (zero `node:`/`undici`) → barrel-appropriate (ENG-281's subpath rationale doesn't apply).

## 4. Idempotency & retry semantics (documentation only — no code change)

`deployManifest` is a **non-idempotent create** (`kubectl create` / HTTP `POST`), **not** a convergent `apply` — calling it twice creates two separately-paid leases. The verb "deploy" is chosen over "apply" to avoid implying convergence.

- **At-least-once** over three irreversible writes: create-lease tx, set-item-custom-domain tx, `uploadLeaseData`. Create-lease is the point of no return.
- **The broadcast leg is already non-retryable.** `cosmosTx` re-codes raw `signAndBroadcast` failures (CosmJS `TimeoutError` / network) to `TX_FAILED` *inside* its `withRetry` closure, and `TX_FAILED ∈ NON_RETRYABLE_ERROR_CODES`, so `isRetryableError` returns false before the transient-message check runs — a post-commit network error does **not** re-broadcast. (Verified: `cosmos.ts:240-258`, `retry.ts:34`, `cosmos.test.ts:311`.) The v2 `maxRetries:0` mitigation was **cut**: it guarded a presently-unreachable path (a transient-coded `ManifestMCPError` post-commit, which no current code produces) at the cost of touching shared `core/cosmos.ts`.
- **No blind retry.** After create-lease a paid lease may exist even when the call throws (lost response / crash / abort between broadcast and extraction). Callers MUST NOT blind-retry; recovery = query existing leases (by tenant, or by `meta_hash` — a deterministic dedup key over the exact bytes) before re-invoking.

## 5. Error handling — structured contract

All failures throw `ManifestMCPError`; `DeployAppResult` stays success-only.

- Boundary (size/validate/SKU/provider/serviceName) throws `INVALID_CONFIG` **before** create-lease.
- **Post-create-lease failures** carry a machine-readable contract in `details`: `{ partial: true, failedStep?: 'set_domain'|'upload'|'poll', lease_uuid, provider_uuid, provider_url }`. `failedStep` is **optional** (consumers tolerate its absence). The underlying failure's `code` is preserved (orthogonal axis — not collapsed to one code).
- **Why a serializable field, not a typed subclass:** `agent-core/classify-deploy-error.ts` consumes a **JSON-serialized** MCP error envelope across a process boundary where `instanceof` is unavailable, so the discriminant must survive serialization (RFC 9457 "Problem Details": consumers branch on a member, not by parsing the human string).
- **`TerminalChainStateError`** path also includes `lease_uuid` in `withContext` (today only `providerUuid`/`providerUrl`).
- **Consumer migration (agent-core).** `classify-deploy-error.ts` branches on `details.partial === true` (strict) **first**, falling back to the existing `'Deploy partially succeeded:'` prefix for cross-version skew. The prefix is retained textually for that fallback but is **not** a contract surface — no prefix-byte-stability test (the existing partial-success message test covers wording incidentally).

## 6. Observability

Via core's `logger`, all objects through `sanitizeForLogging` (manifest body + auth tokens must never hit logs raw):

- boundary reject → `logger.warn` (code + sanitized reason, no manifest body).
- **partial-failure catch** (the recovery-critical case) → `logger.warn('lease <uuid> ...', { lease_uuid, provider_uuid })` — **default-visible** (default `LOG_LEVEL` is `warn`).
- pre-create-lease and success-path post-create-lease → `logger.info(...)`. **Honest caveat:** these are `info`, so they require `LOG_LEVEL ≥ info`; they are an audit aid, **not** a default-on orphan-spend safety net (the default-visible record is the `warn` on the failure path). `meta_hash` (pre-commit) and `lease_uuid` (post-commit) are the correlation keys — no separate trace id.

## 7. Security — user-supplied-manifest threat model

- **Injection via service / storage / domain into on-chain args** (load-bearing). Service names flow into lease items `${skuUuid}:1:${name}`. Mitigation: `validateManifest`'s RFC 1123 DNS-label check runs at step 1 **before** lease-item construction (step 7) — **validate-before-build ordering is load-bearing**; regression test: a malformed service name is rejected with **no create-lease**.
- **V8↔Go parser differential.** Correction to v2: Go `encoding/json` is **also last-wins** on duplicate keys, so a *same-case* duplicate does not diverge — the bespoke dup-key tokenizer was **cut**. The real differential is Go's **case-insensitive** field matching (`image` vs `IMAGE`); `validateManifest`'s existing unknown-field check already rejects a stray `IMAGE`, and we add a small **case-folded top-level-key collision check** (~5 lines in `validateManifest`) to reject manifests with keys differing only by case. The provider remains the canonical Go validator.
- **DoS** — fixed byte cap before parse (§3.1 step 0).
- **Prototype pollution** — trivial top-level `__proto__`/`constructor` own-key reject (defense-in-depth; low reachability — `JSON.parse` stores these as own keys and `deployManifest` never uses the object as a lookup map).

## 8. Backward compatibility

- `deployApp` **public signature, `DeployAppInput`, `DeployAppResult`, and the MCP `deploy_app` schema are unchanged**; internally `deployApp` now JSON-parses + `validateManifest`s its *own* built manifest (which the builders never did) — proven non-regressing by a "builder output always passes `validateManifest`" test. `findSkuUuid` gains an **optional** 3rd param. New exports are additive.
- **Known illegal-states held for compat (noted):** `DeployAppResult.connection`/`connectionError` (and `custom_domain`/`service_name`) are mutually-exclusive runtime pairs typed as independent optionals — kept for backward-compat; the make-illegal-states lens applied to `SkuSelector` is consciously not turned on the frozen result type.

## 9. Testing plan (TDD)

- **No-side-effect, per case.** Every boundary case (oversize, `__proto__`, case-collision, malformed JSON, `validateManifest` fail, serviceName/customDomain incoherence, storage-on-wrong-provider, abort-before-create) asserts the mocked `cosmosTx('billing','create-lease', …)` was **never called**.
- **Hash fidelity (property + examples).** Reordered keys, `\u` escapes, and the bytes passed to mocked `uploadLeaseData` equal the input manifest **verbatim** with `metaHashHex` over those bytes. Ideally a `fast-check` property over valid-but-non-canonical JSON.
- **Anti-over-mocking.** New tests MUST NOT mock `manifest.ts` (run real parse/validate/`metaHashHex`); assert **real effects** (lease-items content, uploaded bytes, hash), not just call-counts.
- **ENG-258 #1/#2** per §2 (assert `sKUs` not-called on `resolved`; provider-pinned storage + provider-aware `INVALID_CONFIG`; `isRetryableError === false`).
- **Structured errors / consumer.** partial failure exposes `details.{partial, failedStep?, lease_uuid, provider_uuid}`; `TerminalChainStateError` carries `lease_uuid`; `classify-deploy-error.ts` branches on `details.partial === true` and still handles the legacy prefix.
- **Observability (security property, not levels).** assert the boundary logs carry **no raw manifest body / token** (via `sanitizeForLogging`); assert the partial-failure path logs `lease_uuid`. Do **not** assert exact log levels (verbosity is config, not a contract).
- **Backward-compat.** `deployApp.test.ts` (950 lines) stays green unchanged; + a wrapper test that builder output always passes `validateManifest`.

## 10. Release / CHANGELOG

- `[Unreleased]` → `### Changed`: new public exports (`deployManifest`, `DeployManifestInput`, `SkuSelector`, `DeployManifestOptions`), additive `findSkuUuid` provider param; partial-success errors now carry `details.partial`/`failedStep` (prefix retained). `### Security`: manifest size cap + case-folded top-level-key collision check at the boundary.
- This is the **fred mono release that unblocks ENG-279** (Barney consumes a published version) — note the version bump/publish step.

## 11. Commit sequencing (one PR, reviewable units)

Each commit independently green so the cross-package changes are bisectable:

- **A — the split + ENG-258:** `deployManifest` + `deployApp`-as-wrapper, `SkuSelector`, `findSkuUuid` provider param (`INVALID_CONFIG`), exports. The actual ENG-279 unblock.
- **B — boundary hardening:** size cap, `__proto__` reject, `validateManifest` case-fold check, validate-before-build security test (§7).
- **C — structured errors + observability + consumer:** `details.partial`/`failedStep`, `TerminalChainStateError` `lease_uuid`, the `agent-core/classify-deploy-error.ts` migration, sanitized boundary logs.

## 12. Out of scope / follow-ups

- ENG-282 typed-object overload (additive; serialize→string→same primitive).
- `agent-core`'s own barrel re-exporting `createGuardedFetch` (ENG-281; separate).
