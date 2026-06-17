# SDK P0a — Plan B: the SDK-direct e2e acceptance (the single tracked P0a metric)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Prove the SDK is real by composing a deploy→…→stopApp flow from **only** `@manifest-network/manifest-sdk` + `manifestjs` — run end-to-end against the live `e2e/docker-compose.yml` (single-service AND a stack-format lease), built **for the browser** (fail-closed; no UNGUARDED node-only modules), with a **per-subpath size budget** (+ a symbol-absence tree-shake check) and the example's compose-only imports machine-enforced by a dependency-cruiser **allowlist**. This is the §9 single tracked P0a acceptance metric. Closes P0a.

**Architecture:** A NEW `examples/sdk-acceptance/` workspace package = a PURE compose-only app — a `runAcceptanceFlow({ config, walletProvider, fetch, variant })` that constructs `createFredClient` and runs the 8-step lifecycle using only the SDK + manifestjs (browser-buildable; runtime deps = exactly those two). The live e2e harness lives in `e2e/` (node — it may use undici/helpers): it builds a **cert-trusting undici fetch** (providerd is HTTPS self-signed on loopback) + the genesis-funded `MnemonicWalletProvider`, imports the example flow **by package name**, and drives it against docker-compose. Browser-safety is proven by a rolldown `platform:browser` build of the example (fail-closed via `UNRESOLVED_IMPORT` capture) + an import-specifier-anchored node scan; tree-shakability by a per-subpath `size-limit` budget + a symbol-absence assertion. Spec §9 + §8.

**Tech Stack:** TypeScript ESM, vitest (e2e + typecheck), rolldown (browser build — a tree dep), size-limit, undici (cert fetch, e2e-only), dependency-cruiser. Issue: ENG-309. Depends on **Plan A COMPLETE + BUILT** (the `manifest-sdk` dist must exist for the example to resolve it).

**⚠️ Three hard truths (get these wrong and the metric is a lie):**
1. **The example app is browser-built; the e2e harness is node.** The cert-trusting undici fetch + the funded wallet + docker assertions live in the `e2e/` test, NEVER in the example `src/` — else the browser build pulls `undici`/`node:` or the example stops being compose-only. The example takes `fetch`/`walletProvider`/`config` as INJECTED params.
2. **Faucet (gas, `umfx`) ≠ billing credit.** Deploying needs BILLING CREDIT in the SKU's price denom (`factory/${POA_ADMIN}/upwr` on this devnet), resolved at runtime from `client.getSKUs()` — NEVER hardcode `umfx`.
3. **A terminal lease state is NOT success.** `subscribeLeaseStatus`'s `onComplete` fires for FAILURE terminals (CLOSED/REJECTED/EXPIRED/PROVISION_FAILED) too — the flow MUST reject on those, or a failed deploy false-greens the metric.

---

## Decisions locked (surface-map `w22t2sarv` + Plan-A impl review `wvxl1d6xt` + Plan-B review `wwrlsi7xk` + spec v9)

- **Q3 — a dedicated `examples/sdk-acceptance/` workspace package** (`private:true`), runtime `dependencies` = EXACTLY `@manifest-network/manifest-sdk` (pinned exact `0.14.0`) + `@manifest-network/manifestjs` — the deps list IS the compose-only contract, machine-enforced by a dependency-cruiser **allowlist** rule on `examples/**` (forbid every `node_modules/` import EXCEPT those two), so a stray `@cosmjs/*`/other import is caught (a denylist of only `manifest-mcp-*` would miss it).
- **Q1 — the `executeTx` batch hand-builds two `MsgFundCredit`** EncodeObjects from the manifestjs codec at `@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js` (`/liftedinit.billing.v1.MsgFundCredit`, `{sender, tenant, amount: Coin}`) — an atomic double-fund (the most representative all-or-nothing batch). A deep `dist/codegen/...` VALUE import is a **sanctioned manifestjs import** (the repo idiom; the allowlist permits `manifestjs`). The caller sets `sender`/`tenant`. `build*Msg` helpers deferred (P0b/P2).
- **Q2 — positional fred fns bridged via the client-as-ctx** (§5.7 defers ctx-ification to P2): `deployApp`/`getLeaseConnectionInfo`/`restartApp`/`updateApp`/`getAppLogs` take positional DI; the ~10-line address-closing+arity-adapting bridge is the intended shape (signature-accurate, reviewer-confirmed).
- **TLS — an in-process undici `Agent({connect:{ca}})` trusting the providerd cert**, wrapped as a `fetch` and injected via `createFredClient({ fetch })` from the e2e test (verified: the SDK threads `ctx.fetch` through ALL provider HTTPS, no guarded-fetch override). Cert SAN is `localhost`.
- **Browser build — rolldown `platform:browser`, fail-closed via `UNRESOLVED_IMPORT` capture** (rolldown does NOT hard-throw on an unresolved node builtin — it warns + externalizes; so we capture warnings and assert the set is empty MINUS a documented allowlist) + an import-specifier-anchored scan. **Allowlist: `@cosmjs/crypto`'s guarded optional `require("crypto")`** (it degrades to pure-JS in browsers, like core's guarded fetch). Spec §9 reworded to "no UNGUARDED node-only modules" (the literal "no node builtins" is false today with the pinned cosmjs — see the spec note).
- **Size — `sideEffects:false` on core/fred/agent-core (VERIFIED safe: zero import-time side effects — the signing path uses an explicit `new Registry([...])`, not implicit self-registration)** + a per-subpath `size-limit` budget with TIGHT headroom + a complementary **symbol-absence** check (assert `executeTx`/`signArbitraryWithAmino`/`MsgFundCredit` ABSENT from the tree-shaken `/reads` chunk — the gzip floor alone has ~3% discriminating power on the ~1MB codegen floor).
- **SDK type tripwire** — `packages/sdk/*.test-d.ts` under `vitest --typecheck`.
- Same `fileParallelism:false` / single-genesis-tenant discipline; `testTimeout:300_000`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` (root, modify) | `workspaces` → `["packages/*", "examples/*"]` (order matters — SDK builds before the example); `depcruise` script → `depcruise packages examples …`; biome `check` → `packages/ examples/`. |
| `biome.json` (modify) | `files.includes` → `["packages/**", "examples/**"]` (so the example is linted). |
| `examples/sdk-acceptance/package.json` (create) | name `@manifest-network/sdk-acceptance` (`private:true`), `main`/`types`/`exports`/`files`, deps = SDK (exact) + manifestjs; build/lint/test scripts. |
| `examples/sdk-acceptance/{tsconfig.json,tsdown.config.ts}` (create) | neutral build (the flow type-checks + browser-bundles). |
| `examples/sdk-acceptance/src/flow.ts` (create) | `runAcceptanceFlow({config,walletProvider,fetch,variant})` — the 8-step lifecycle, compose-only. |
| `examples/sdk-acceptance/src/index.ts` (create) | `export { runAcceptanceFlow } from './flow.js';` (the package entry the e2e imports). |
| `examples/sdk-acceptance/src/main.ts` (create) | the browser-build entry (imports the flow; bundled, never run in CI). |
| `examples/sdk-acceptance/src/flow.test.ts` (create) | UNIT test of the flow vs a mocked SDK (TDD; no docker). |
| `e2e/sdk-acceptance.e2e.test.ts` (create) | the live harness: cert-trusting undici fetch + funded wallet → drive the flow single + stack vs docker-compose. |
| `examples/sdk-acceptance/scripts/browser-build.test.ts` (create) | rolldown `platform:browser` fail-closed build + anchored node scan + the `/reads` symbol-absence check. |
| `.dependency-cruiser.cjs` (modify) | the `examples/**` compose-only ALLOWLIST rule + `^examples/[^/]+/dist/` in `exclude`. |
| `tools/depcruise-fixtures/` + `.../.dependency-cruiser.fixtures.cjs` (modify) | add an `example-src/bad-import.ts` fixture + a re-anchored rule; `cast-guard.test.ts` cruises `packages examples` + an example-src positive control. |
| `packages/{core,fred,agent-core}/package.json` (modify) | `sideEffects:false` (verified). |
| root `package.json` + `.size-limit.json` (create/modify) | per-subpath `size-limit` budget. |
| `packages/sdk/src/sdk.test-d.ts` + `packages/sdk/vitest.config.ts` (create) | the SDK type tripwire. |
| `docs/superpowers/specs/2026-06-10-…-design.md` (§9, modify) | reword "no node builtins" → "no UNGUARDED node-only modules" + the cosmjs-crypto allowlist note. |
| `docs/superpowers/specs/manifest-app-sdk-readiness.md` (modify) | tick §H rows; P0a close-out. |
| `.github/workflows/ci.yml` (modify) | browser-build + size + sdk-typecheck + depcruise-examples steps (committed locally; user merges — gh-token). |

---

## Task B0: Confirm baseline + the spec §9 reword

- [ ] Worktree root: `npm install`, `npm run build` (9 pkgs incl. the built SDK dist — REQUIRED so the example can resolve it), `npm run lint`, `npx vitest run packages/` (green), `npm run check`, `npm run depcruise` (clean + fixtures fail), the SDK browser-resolution + (Plan A) tests green. HEAD is the Plan-B commits. Confirm `docker compose -f e2e/docker-compose.yml` is available. If red, STOP.
- [x] **Reword spec §9** (the browser claim) — DONE (applied directly in the spec v10 idiom-audit `wiu4qu9j6`, commit on the spec): §9 + scorecard now say "no UNGUARDED node-only modules" with the documented `@cosmjs/crypto` guarded-crypto allowlist + the fail-closed-with-allowlist + anchored-scan-with-bare-`crypto`/browserify-shims + a positive Web-Crypto assertion. No executor action — the spec already carries it; B4 below implements the test to match.

---

## Task B1: The example workspace package + the compose-only ALLOWLIST guard

**Files:** root `package.json` + `biome.json`, `examples/sdk-acceptance/{package.json,tsconfig.json,tsdown.config.ts,src/index.ts}`, `.dependency-cruiser.cjs`, `tools/depcruise-fixtures/*`, `cast-guard.test.ts`.

- [ ] **Step 1: Root workspaces + tooling scope.** root `package.json`: `"workspaces": ["packages/*", "examples/*"]` (SDK-before-example order); `"depcruise": "depcruise packages examples --config .dependency-cruiser.cjs"`; `"check": "biome check packages/ examples/"`. `biome.json`: `files.includes` → `["packages/**", "examples/**"]`.

- [ ] **Step 2: `examples/sdk-acceptance/package.json`** — WITH a resolvable entry point (a bare-specifier import needs `main`/`exports`):

```json
{
  "name": "@manifest-network/sdk-acceptance",
  "version": "0.14.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": { "lint": "tsc --noEmit", "build": "tsdown", "test": "vitest run" },
  "dependencies": {
    "@manifest-network/manifest-sdk": "0.14.0",
    "@manifest-network/manifestjs": "<exact version from packages/core/package.json>"
  },
  "devDependencies": { "typescript": "5.9.3", "vitest": "4.1.8" }
}
```

  (SDK dep EXACT `0.14.0` — always-pin. NO `@types/node` — the src is pure DI; node types invite accidental `Buffer`/`process` use. Copy the exact `manifestjs` version from core.)

- [ ] **Step 3: `tsconfig.json`** (extends base, refs `../../packages/sdk`) + **`tsdown.config.ts`** (copy fred's esm/unbundle/dts/neutral) + **`src/index.ts`** = `export { runAcceptanceFlow } from './flow.js';` (NOT a placeholder — this is the package entry the e2e imports; `flow.ts` lands in B2, so until then a stub `flow.ts` with the signature keeps the build green).

- [ ] **Step 4: The `examples/**` compose-only ALLOWLIST rule** — `.dependency-cruiser.cjs` `forbidden` (+ add `^examples/[^/]+/dist/` to the `exclude`):

```js
    // The acceptance example composes ONLY the public SDK + manifestjs (spec §8 (d) / §9). ALLOWLIST,
    // not denylist: forbid ANY node_modules import except those two, so a stray @cosmjs/* / undici / ws
    // is caught too (test files exempt — they may use manifestjs codecs). Tune the path regex to
    // dependency-cruiser's emitted module paths.
    {
      name: 'example-composes-only-sdk',
      comment: 'examples/**/src may import only @manifest-network/manifest-sdk + @manifest-network/manifestjs (spec §9).',
      severity: 'error',
      from: { path: '^examples/[^/]+/src', pathNot: '\\.test\\.ts$' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-no-pkg', 'npm-unknown'],
        pathNot: 'node_modules/@manifest-network/(manifest-sdk|manifestjs)(/|$)',
      },
    },
```

  And widen the cruise scope so the rule actually runs: the root `depcruise` script (Step 1) now cruises `packages examples`, and `cast-guard.test.ts`'s real-tree + fixtures invocations change to `depcruise packages examples`.

- [ ] **Step 5: Prove the rule fires (MF-1/MF-3) — fixtures + a PRODUCTION-config positive control.** (a) `tools/depcruise-fixtures/example-src/bad-import.ts` = `import '@manifest-network/manifest-mcp-core';` + a re-anchored rule (`from:^example-src/`) in `.dependency-cruiser.fixtures.cjs` reusing the production `to`; add `'example-src'` to the fixtures cruise arg list. (b) In `cast-guard.test.ts`, add a positive control mirroring the `manifestjs-types-chokepoint` probe: write `examples/sdk-acceptance/src/__probe.ts` importing `@cosmjs/proto-signing`, cruise the PRODUCTION config (`depcruise packages examples`), assert `example-composes-only-sdk` fires, delete the probe. (If the `exclude` swallows the symlinked dist target, match on the unresolved specifier — the allowlist's `to.path` should match the resolved `node_modules/@cosmjs/...` path; verify it actually flags.)

- [ ] **Step 6: Run → `npm install` + build the example (stub) + `npm run depcruise` (real tree clean, fixtures + probe fire) + `npm run check` (now covers examples) + full-repo lint.** Commit. `git commit -m "feat(examples): scaffold sdk-acceptance compose-only example + dependency-cruiser allowlist guard (ENG-309)"`.

---

## Task B2: The acceptance flow (`runAcceptanceFlow`) — TDD against a mocked SDK

**Files:** `examples/sdk-acceptance/src/flow.ts`, `flow.test.ts`, `main.ts`.

- [ ] **Step 1: Failing unit test** — `flow.test.ts` mocks `@manifest-network/manifest-sdk` + `/deploy` so the flow runs WITHOUT docker. Assert: (a) builds `createFredClient` from `{config,walletProvider,fetch}`; (b) resolves the credit denom from `getSKUs()` (stub `docker-micro.basePrice.denom = 'factory/x/upwr'`) and `fundCredits` uses it; (c) `single` calls the 8 steps in order; (d) `stack` deploys a `{services:{…}}` spec + passes `serviceName:'web'` to setItemCustomDomain + uses `buildStackManifest` for the update; (e) the executeTx batch is two `/liftedinit.billing.v1.MsgFundCredit` EncodeObjects with `sender===tenant===addr` and `amount.denom===the SKU denom`; (f) `getLeasesByTenant` is called with `stateFilter: LeaseState.LEASE_STATE_ACTIVE`; (g) subscribe RESOLVES on an ACTIVE terminal; (f′) subscribe **REJECTS** on a FAILURE terminal (CLOSED/PROVISION_FAILED); (h) a 409 from restart/update is retried.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `flow.ts`** (compose-only; imports corrected per the review B-3/B-4/B-5/B-7):

```ts
import {
  createFredClient, parseFqdn, asLeaseUuid,
  type FredClient, type ManifestMCPConfig, type WalletProvider,
} from '@manifest-network/manifest-sdk';
import {
  createAuthTokens,
  deployApp, getLeaseConnectionInfo, restartApp, updateApp, getAppLogs, // positional fred fns (P2 bridge)
  buildManifest, buildStackManifest,
  LeaseState, PROVISION_FAILED,
  type FredLeaseStatus, type EncodeObject,
} from '@manifest-network/manifest-sdk/deploy';
import { MsgFundCredit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js'; // sanctioned

type DeploySpec = Parameters<typeof deployApp>[3]; // drift-proof — no need for AppDeploySpec to be re-exported

export interface AcceptanceOpts {
  config: ManifestMCPConfig;
  walletProvider: WalletProvider;
  fetch: typeof globalThis.fetch; // injected (cert-trusting undici in e2e; globalThis.fetch in browser)
  variant: 'single' | 'stack';
}

const FAILURE_TERMINALS = [LeaseState.LEASE_STATE_CLOSED, LeaseState.LEASE_STATE_REJECTED, LeaseState.LEASE_STATE_EXPIRED];

export async function runAcceptanceFlow(opts: AcceptanceOpts): Promise<void> {
  const client: FredClient = await createFredClient({ config: opts.config, walletProvider: opts.walletProvider, fetch: opts.fetch });
  try {
    const addr = await client.chain.getAddress();
    const tokens = createAuthTokens(client.signer, { chainId: client.chain.getConfig().chainId });
    // §2c bridge: address-closing + arity-adapting the address-bound thunks for the positional fred fns.
    const getAuthToken = (_a: string, uuid: string) => tokens.getAuthToken(asLeaseUuid(uuid));
    const getLeaseDataAuthToken = (_a: string, uuid: string, mh: string) => tokens.getLeaseDataAuthToken(asLeaseUuid(uuid), mh);

    // 0) BILLING CREDIT — resolve the SKU price denom (NOT gas/umfx) and self-fund.
    const skus = await client.getSKUs();
    const micro = skus.find((s) => s.name === 'docker-micro');
    if (!micro) throw new Error('docker-micro SKU not found on chain');
    const creditDenom = micro.basePrice.denom; // factory/${POA_ADMIN}/upwr — billing, NOT gas
    await client.fundCredits({ amount: `5000000${creditDenom}` });

    // 1) deploy
    const spec: DeploySpec = (opts.variant === 'stack'
      ? { services: { web: { image: 'nginxinc/nginx-unprivileged:alpine', ports: { '8080/tcp': {} } } }, size: 'docker-micro' }
      : { image: 'nginxinc/nginx-unprivileged:alpine', port: 8080, size: 'docker-micro' }) as DeploySpec;
    const deployed = await deployApp(client.chain, getAuthToken, getLeaseDataAuthToken, spec, {}, client.fetch);
    const leaseUuid = deployed.lease_uuid;
    const serviceName = opts.variant === 'stack' ? 'web' : undefined;

    // 2) query (bound)
    await client.getLeasesByTenant({ tenant: addr, stateFilter: LeaseState.LEASE_STATE_ACTIVE });
    const lease = await client.getLease(leaseUuid);
    if (!lease) throw new Error(`lease ${leaseUuid} not found after deploy`);

    // 3) getLeaseConnectionInfo (positional; reuse deployed.provider_url)
    await getLeaseConnectionInfo(deployed.provider_url, leaseUuid, await tokens.getAuthToken(asLeaseUuid(leaseUuid)), client.fetch);

    // 4) setItemCustomDomain (bound; serviceName required for the stack item) — feature-gated (see B3 MF-6 note)
    await client.setItemCustomDomain({ leaseUuid: asLeaseUuid(leaseUuid), customDomain: parseFqdn('app.example.com'), serviceName });

    // 5) restart / update / getLogs (positional; poll-on-409). The update manifest is variant-shaped:
    await retryOn409(() => restartApp(client.query, addr, leaseUuid, getAuthToken, client.fetch));
    const updateManifest = opts.variant === 'stack'
      ? buildStackManifest({ services: (spec as { services: Record<string, { image: string; ports: Record<string, object> }> }).services })
      : buildManifest({ image: (spec as { image: string }).image, ports: { '8080/tcp': {} } });
    await retryOn409(() => updateApp(client.query, addr, leaseUuid, getAuthToken, JSON.stringify(updateManifest), undefined, client.fetch));
    await getAppLogs(client.query, addr, leaseUuid, getAuthToken, 100, client.fetch);

    // 6) executeTx BATCH — two MsgFundCredit (atomic double-fund); caller sets sender/tenant.
    const fundMsg = (): EncodeObject => ({
      typeUrl: '/liftedinit.billing.v1.MsgFundCredit',
      value: MsgFundCredit.fromPartial({ sender: addr, tenant: addr, amount: { denom: creditDenom, amount: '1' } }),
    });
    await client.executeTx([fundMsg(), fundMsg()]);

    // 7) subscribeLeaseStatus (poll) — resolve on SUCCESS terminal, REJECT on FAILURE terminal (not a false-green)
    await new Promise<FredLeaseStatus>((resolve, reject) => {
      const stop = client.subscribeLeaseStatus(asLeaseUuid(leaseUuid), {
        onData: () => {},
        onComplete: (final) => {
          const failed = FAILURE_TERMINALS.includes(final.state)
            || (final.provision_status !== undefined && PROVISION_FAILED.has(final.provision_status));
          if (failed) reject(new Error(`lease reached a FAILURE terminal: ${final.state}/${final.provision_status}`));
          else resolve(final);
        },
        onError: (e) => { stop(); reject(e); },
        timeout: 120_000,
      });
    });

    // 8) stopApp (bound)
    await client.stopApp({ leaseUuid: asLeaseUuid(leaseUuid) });
  } finally {
    client.dispose();
  }
}

/** Provider returns 409 'invalid state' until a prior change settles (lifecycle.e2e: retry ≤10×). */
async function retryOn409(fn: () => Promise<unknown>, tries = 10): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { await fn(); return; } catch (e) {
      const status = (e as { status?: number }).status; // ProviderApiError carries .status
      if (status !== 409 || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
```

  (The `DeploySpec = Parameters<typeof deployApp>[3]` typing replaces every `as never` (it is drift-proof + needs no AppDeploySpec re-export); the inner `as {…}` narrowings on `spec.services`/`spec.image` are the variant projections. Confirm `PROVISION_FAILED` is re-exported on `/deploy` (Plan 4d Task 5 exported it from fred; Plan A `/deploy` re-exports it). `MsgFundCredit.fromPartial` amount is a `Coin` `{denom, amount:string}`.)

- [ ] **Step 4: `main.ts`** = `import { runAcceptanceFlow } from './flow.js';` + a thin browser entry that calls it with browser-supplied args (never run in CI — only bundled in B4 to prove browser-safety; this is what makes the browser build MEANINGFUL — it pulls the whole flow graph).

- [ ] **Step 5: Run the unit test → pass + build the example + full-repo lint + Biome + commit.** `git commit -m "feat(examples): compose-only deploy->stopApp acceptance flow (denom-from-SKU, failure-terminal-rejects, single + stack) (ENG-309)"`.

---

## Task B3: The live e2e harness (single + stack) against docker-compose

**Files:** `e2e/sdk-acceptance.e2e.test.ts` (+ verify `e2e/vitest.config.ts` glob).

- [ ] **Step 1: The e2e test** — node harness; TLS via an in-process undici `Agent` trusting the providerd cert:

```ts
import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import { describe, it } from 'vitest';
import { MnemonicWalletProvider, type ManifestMCPConfig } from '@manifest-network/manifest-sdk';
import { runAcceptanceFlow } from '@manifest-network/sdk-acceptance';

const DEFAULT_MNEMONIC = '<verbatim from e2e/helpers/mcp-client.ts:6 — the genesis-funded tenant>';
const config: ManifestMCPConfig = { chainId: 'manifest-localnet', rpcUrl: 'http://localhost:26657', gasPrice: '0.01umfx', addressPrefix: 'manifest' };

// providerd is HTTPS self-signed on loopback → trust its cert via an undici Agent, wrapped as fetch and
// INJECTED into the SDK (createFredClient({ fetch })). In-process, no NODE_EXTRA_CA_CERTS race; node-only,
// confined to THIS test (kept out of the browser-built example). E2E_TLS_CERT_PATH is set by global-setup.
function certTrustingFetch(): typeof globalThis.fetch {
  const ca = readFileSync(process.env.E2E_TLS_CERT_PATH as string, 'utf8');
  const dispatcher = new Agent({ connect: { ca } });
  return ((input, init) => undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as typeof globalThis.fetch;
}

describe('SDK acceptance (compose-only, live chain)', () => {
  const run = async (variant: 'single' | 'stack') => {
    const walletProvider = new MnemonicWalletProvider(config, DEFAULT_MNEMONIC);
    await walletProvider.connect();
    await runAcceptanceFlow({ config, walletProvider, fetch: certTrustingFetch(), variant });
  };
  it('single-service: deploy → … → stopApp', () => run('single'), 300_000);
  it('stack-format lease: deploy → … → stopApp', () => run('stack'), 300_000);
});
```

  (Verify `MnemonicWalletProvider`'s ctor `(config, mnemonic)` + `connect()` against core; drop the `as never`/cast hacks once confirmed (N-1). Copy the verbatim `DEFAULT_MNEMONIC`. `undici`/`node:fs` stay in THIS file only.)

- [ ] **Step 2: Verify the glob + build-order (MF-5).** `e2e/vitest.config.ts` `include:['**/*.e2e.test.ts']` already picks up the new file (confirm; keep `fileParallelism:false`/`testTimeout:300_000`). The e2e imports the BUILT `@manifest-network/sdk-acceptance` — so the test:e2e flow MUST build it first: ensure `npm run build` (B0) builds the example after the SDK (workspaces order), and add `npm run build -w @manifest-network/sdk-acceptance` to the e2e run recipe.

- [ ] **Step 3: setItemCustomDomain feature gate (MF-6).** The on-chain custom-domain feature is chain-version-gated (`billing-custom-domain.e2e.test.ts` probes + skips on old images). Either gate step 4 of the flow on the same probe (skip when unsupported) OR pin/document the minimum `manifest-ledger` image in B0/the docker-compose. Pick the probe-skip (more robust to image drift); thread a `skipCustomDomain?: boolean` into `AcceptanceOpts` set by the e2e after probing, or document the min image in the plan + compose.

- [ ] **Step 4: Run it live.** `docker compose -f e2e/docker-compose.yml up -d --wait --wait-timeout 180`; `npm run build`; `npx vitest run e2e/sdk-acceptance.e2e.test.ts` → both variants green; `down -v --remove-orphans`. (If the genesis balance can't cover deploy+stack+updates+double-fund, raise the `fundCredits` amount. **Primary live risk: does the stack-format lease provision to ACTIVE on this devnet** — no existing e2e provisions a stack; if it can't, fall back to documenting the stack path as build-only-validated + keep the single-service live gate.) Commit. `git commit -m "test(e2e): SDK-direct acceptance — compose-only deploy->stopApp single + stack vs docker-compose (ENG-309)"`.

---

## Task B4: The browser build (fail-closed) + anchored scan + tree-shake symbol check

**Files:** `examples/sdk-acceptance/scripts/browser-build.test.ts`, `examples/sdk-acceptance/package.json` (rolldown devDep).

- [ ] **Step 1: Failing test** — `browser-build.test.ts`:

```ts
import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

// rolldown platform:browser does NOT throw on an unresolved node builtin — it WARNS (UNRESOLVED_IMPORT)
// and externalizes. So capture warnings + assert the set is empty MINUS a documented allowlist, and scan
// the chunk with an IMPORT-SPECIFIER-ANCHORED regex (a bare 'node:' substring false-fails on the benign
// Telescope `base:{node:…}` key, and misses a bare `require("crypto")`).
const ALLOWLISTED = [/@cosmjs\/crypto/]; // guarded optional require("crypto") — degrades to pure-JS in browsers

describe('sdk-acceptance browser build (fail-closed; no UNGUARDED node-only)', () => {
  it('bundles for the browser with no unallowed node-only resolution + clean chunk', async () => {
    const warnings: string[] = [];
    const bundle = await rolldown({
      input: new URL('../dist/main.js', import.meta.url).pathname,
      platform: 'browser',
      onLog: (level, log) => { if (log.code === 'UNRESOLVED_IMPORT') warnings.push(log.message ?? String(log)); },
    });
    const { output } = await bundle.generate({ format: 'esm' });
    await bundle.close();
    const unallowed = warnings.filter((w) => !ALLOWLISTED.some((re) => re.test(w)));
    expect(unallowed).toEqual([]); // PRIMARY: fail-closed — any NEW unresolved node builtin fails here
    const code = output.filter((o) => o.type === 'chunk').map((o) => (o as { code: string }).code).join('\n');
    // SECONDARY: import-specifier-anchored scan (not a bare substring) for a node-only import/require +
    // the browserify SHIM names. NOTE: bare `crypto` is intentionally NOT scanned — the allowlisted
    // @cosmjs/crypto guarded `require("crypto")` legitimately appears in the chunk and is handled
    // BY SOURCE by the PRIMARY warning-capture above; scanning `crypto` here would false-fail.
    const leak = code.match(/(?:from|require\(|import\()\s*['"](?:node:|fs|path|http|https|net|tls|stream|os|async_hooks|undici|ws|crypto-browserify|process\/browser|stream-browserify)['"]/);
    expect(leak, leak?.[0]).toBeNull();
    // POSITIVE: prove the Web-Crypto path shipped (not a node-shim) — the cosmjs guarded crypto degrades here.
    expect(/globalThis\.crypto|crypto\.subtle|getRandomValues/.test(code)).toBe(true);
  });

  it('the /reads tree-shaken chunk pulls NO tx/signer/codec symbols (tree-shakability belt)', async () => {
    const bundle = await rolldown({ input: new URL('../node_modules/@manifest-network/manifest-sdk/dist/reads.js', import.meta.url).pathname, platform: 'browser' });
    const { output } = await bundle.generate({ format: 'esm' });
    await bundle.close();
    const code = output.filter((o) => o.type === 'chunk').map((o) => (o as { code: string }).code).join('\n');
    for (const sym of ['executeTx', 'signArbitraryWithAmino', 'MsgFundCredit', 'fundCredits'])
      expect(code.includes(sym), sym).toBe(false);
  });
});
```

  (Add `rolldown: "1.0.3"` to the example devDeps. Tune the `onLog` signature + the `/reads` resolve path to the installed rolldown API. The `crypto` allowlist is the documented exception from B0; the anchored scan + the warning-set are the two real guards.)

- [ ] **Step 2: Run → build the example → pass; confirm the negative case** (temporarily inject a `import 'node:fs'` into `main.ts` → the test FAILS on the unallowed warning + the scan; revert). Add a `ci.yml` step (rolldown browser build — no live chain). **gh-token: commit ci.yml locally, flag for user merge.** Commit. `git commit -m "test(examples): fail-closed browser build (UNRESOLVED_IMPORT capture + anchored scan) + /reads tree-shake check (ENG-309)"`.

---

## Task B5: `sideEffects:false` + types-first retrofit + per-subpath size budget

**Files:** `packages/{core,fred,chain,lease,cosmwasm,agent,agent-core,node}/package.json`, root `package.json` + `.size-limit.json`, `ci.yml`.

- [ ] **Step 0: types-first `exports` retrofit on the 8 PUBLIC packages (spec §13, v10 audit).** core/fred/chain/lease/cosmwasm/agent/agent-core/node currently order `import` before `types` in their `exports` `.` (and subpath) blocks → publint `EXPORTS_TYPES_SHOULD_BE_FIRST`. Keep-public makes them part of the published surface a publint/attw gate covers. Reorder every block so `types` is FIRST (the `node`/`default`/`import` conditions after). Mechanical; verify `npm run build` + (if wired) publint stays green. Commit separately: `git commit -m "fix(packaging): types-first exports ordering on the 8 public packages (publint; ENG-309)"`.

- [ ] **Step 1: Verify no import-time side effects** (the review CONFIRMED this is safe — zero import-time side effects across all three; the signing path uses an explicit `new Registry([...])`, not implicit self-registration). Re-confirm with a grep for top-level executable statements; a top-level `const x = new Y()` pure init (logger singleton, `Object.freeze`) is fine. Document. The residual class a grep can't see (`const X = sideEffectingCall()`) is backstopped by Step 2's full gate + the revert guard.

- [ ] **Step 2: Add `"sideEffects": false`** to `packages/core/package.json`, `packages/fred/package.json`, `packages/agent-core/package.json`. Run the FULL gate (`npm run build` + `npm run lint` + `npx vitest run packages/` + the SDK browser-resolution test) — all green (a dropped load-bearing side effect surfaces as a test failure). If anything breaks, revert that package's flag + document.

- [ ] **Step 3: Per-subpath size budget (MF-8)** — `.size-limit.json`, one entry per public SDK subpath using `import:` (tree-shakability machine-pinned). MEASURE first, then set each `limit` to the measured gzip + **TIGHT headroom (~2–3 KB, not a round number)** so an accidental TX/deploy/node pull bites (the ~1 MB cosmjs/manifestjs codegen floor gives the gzip budget only ~3% discriminating power — the B4 `/reads` symbol-absence check is the real leak guard; the size budget is a coarse floor-regression tripwire, document that):

```json
[
  { "name": "manifest-sdk /reads", "path": "packages/sdk/dist/reads.js", "import": "{ getLease, getBalance }", "limit": "<measured + 2KB>" },
  { "name": "manifest-sdk /catalog", "path": "packages/sdk/dist/catalog.js", "import": "{ resolveSku }", "limit": "<measured + 2KB>" },
  { "name": "manifest-sdk /deploy", "path": "packages/sdk/dist/deploy.js", "import": "{ deployApp }", "limit": "<measured + 3KB>" },
  { "name": "manifest-sdk root client", "path": "packages/sdk/dist/index.js", "import": "{ createManifestClient }", "limit": "<measured + 3KB>" }
]
```

  Add `size-limit` + `@size-limit/preset-small-lib` (covers ESM gzip) EXACT-pinned root devDeps; a `"size": "size-limit"` script; a `ci.yml` step. Commit (ci.yml local). `git commit -m "feat(sdk): sideEffects:false on core/fred/agent-core + per-subpath size-limit budget (ENG-309)"`.

---

## Task B6: SDK type tripwire

**Files:** `packages/sdk/src/sdk.test-d.ts`, `packages/sdk/vitest.config.ts`, `packages/sdk/package.json` (test script → `--typecheck`).

- [ ] **Step 1: `vitest.config.ts`** for the sdk package mirroring core's (`typecheck` enabled, `include:['src/**/*.test-d.ts']`); wire `vitest --typecheck` into the sdk `test`/`test:types` script + CI.
- [ ] **Step 2: `sdk.test-d.ts`** — pin the re-emitted type surface (codegen-passthrough tripwire, spec §14): `createManifestClient`/`createManifestReadClient`/`createFredClient` return the expected client types; `ManifestClient` has the bound read+tx+executeTx methods; the brand families + ports export as types; `ManifestReadClient` NOT assignable to `ManifestClient`. Use `expectTypeOf` (`toExtend`/`toEqualTypeOf`, not the deprecated `toMatchTypeOf`).
- [ ] **Step 3: Run `vitest --typecheck` → pass; confirm a deliberately-wrong assertion FAILS under `--typecheck` (then revert).** Add the CI step (local; flag). Commit. `git commit -m "test(sdk): type tripwire (*.test-d.ts under vitest --typecheck) (ENG-309)"`.

---

## Task B7: Scorecard reconciliation + P0a close-out

**Files:** `docs/superpowers/specs/manifest-app-sdk-readiness.md`, this plan.

- [ ] **Step 1: Tick the §H rows** — SDK package (A) ☑; example app + e2e acceptance ☑; browser build (no-UNGUARDED-node, fail-closed) ☑; per-subpath size budget + tree-shake symbol check ☑; publint/attw (A) ☑; dependency-cruiser incl. the example compose-only allowlist ☑. Note (a) the honest size-floor caveat (codegen-dominated; subpaths = an API-surface/symbol-scoping win; the symbol-absence check is the real tree-shake guard), and (b) **the CI-vs-local split (N-6): CI enforces the bundle/size/types/unit/depcruise subset; the LIVE e2e ("it deploys") is a local/manual gate (no docker job in ci.yml)** — do NOT claim "CI = done."

- [ ] **Step 2: Full gate** — `npm run build`, `npm run lint`, `npx vitest run packages/`, `npm run check` (covers examples), `npm run depcruise` (+ fixtures + the example positive-control fire), the SDK browser-resolution + type-tripwire, the example browser build + the `/reads` symbol-absence + size budget; then the LIVE e2e (`docker compose up` → build → `npx vitest run e2e/sdk-acceptance.e2e.test.ts` single + stack → `down`). All green ⇒ **P0a is COMPLETE.**

- [ ] **Step 3: Commit.** `git commit -m "docs(sdk): reconcile readiness scorecard — P0a acceptance complete (ENG-309)"`.

---

## Self-Review (completed; Plan-B review `wwrlsi7xk` blockers + must-fixes folded in)

- **Spec §9 acceptance:** compose-only example (deps = exactly SDK + manifestjs, ALLOWLIST-enforced) run e2e (deploy→query→connection→domain→restart/update/logs→executeTx-batch→subscribe→stopApp, single + stack) against docker-compose, PLUS a fail-closed browser build (no-UNGUARDED-node, cosmjs-crypto allowlisted) + per-subpath size budget + the `/reads` tree-shake symbol-absence check. Both §9 claims covered.
- **Blockers fixed:** B-1 example has `exports`/`main` (+ index.ts re-exports the flow); B-2 credit denom resolved from `getSKUs()` (not `umfx`); B-3 flow imports split correctly (ROOT vs /deploy), no duplicate factory import; B-4 `MsgFundCredit` from the full `dist/codegen/.../tx.js`; B-5 `stateFilter: LeaseState.LEASE_STATE_ACTIVE`; B-6 depcruise cruises `packages examples` (+ exclude examples dist) so the rule actually runs; B-7 `buildStackManifest` for stack / `buildManifest({image,ports})` for single (no `as never`); B-8 fail-closed browser build via UNRESOLVED_IMPORT capture + anchored scan + the cosmjs-crypto allowlist + the §9 reword.
- **Must-fixes folded:** MF-1/3 production-config positive control + fixture; MF-2 ALLOWLIST (catches @cosmjs); MF-4 subscribe REJECTS on a failure terminal (no false-green); MF-5 build-before-e2e; MF-6 custom-domain feature gate; MF-7 biome covers examples/; MF-8 size symbol-absence belt + tight headroom; MF-9 exact SDK pin + workspaces order.
- **Confirmed strengths kept:** `sideEffects:false` IS safe (verified); the positional bridge is signature-accurate; the TLS/undici approach is correct; the executeTx double-fund is encodable; poll-on-409 works (ProviderApiError.status). Type consistency: `AcceptanceOpts` + the `DeploySpec = Parameters<typeof deployApp>[3]` typing + the import split are consistent across flow.ts / flow.test.ts / the e2e.
- **gh-token:** all `.github/workflows/*` edits committed locally, flagged for the user to merge.

## Next

→ **P0a is the gate; once green, P0a is DONE.** The spine lands as ONE PR on `worktree-sdk-phase0-spec` (user merges; the workflow-file commits need the user's push). Then **P1** (agent-core `DeploySpec` full-fidelity superset, ENG-310) + the deferred items (P2 ctx-ification of the positional fred fns so a future example drops the bridge; `build*Msg` helpers; the WS `EventTransport`; API Extractor at 1.0; a real multi-service stack image if the devnet supports it).
