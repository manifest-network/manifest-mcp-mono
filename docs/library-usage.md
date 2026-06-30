# SDK cookbook

[`@manifest-network/manifest-sdk`](../packages/sdk/README.md) is the supported way to build a TypeScript app on Manifest + Fred without speaking the MCP protocol. It aggregates `core` + `fred` + `agent-core` behind one typed surface, so an app composes **only** the SDK and [`manifestjs`](https://www.npmjs.com/package/@manifest-network/manifestjs). The reference consumer is **Barney**, the Manifest web frontend.

This is the deep dive. For a 60-second start, see the [SDK README](../packages/sdk/README.md).

```bash
npm install @manifest-network/manifest-sdk @manifest-network/manifestjs
```

> **Browser compatibility.** The SDK barrel and every subpath except `/node` are browser-safe (built `platform: "neutral"`, no Node builtins). `/node` is the one node-only entry (the SSRF-guarded fetch). Use a `cosmos-kit` / Keplr / Leap wallet for browser apps.

## Choosing a client

Three factories, all returning a bound client whose methods close over the ports for you. Pick by what you need to do:

| Factory | Needs a wallet? | Gives you |
|---------|-----------------|-----------|
| `createManifestReadClient` | No | Chain **reads** only (`getBalance`, `getLease`, `getSKUs`, …) |
| `createManifestClient` | Yes | Reads **+ on-chain transactions** (`fundCredits`, `setItemCustomDomain`, `stopApp`, `executeTx`) |
| `createFredClient` | Yes | Everything above **+ the Fred provider lifecycle** (`deployApp`, `appStatus`, `getAppLogs`, `restartApp`, `updateApp`, `subscribeLeaseStatus`, …) |

All three share the same options (`{ config, fetch?, logger? }` — plus a required `walletProvider` for the two signing factories, and a few not-yet-active `@beta` fields) and the same lifecycle rule: **`dispose()` every client** when you're done. Clients keyed by the same config share one underlying `CosmosClientManager` connection (torn down when the last holder disposes), and `getInstance` *mutates* that shared instance — so don't hold two clients against the **same config key** at once (e.g. a read client and a signing client). In practice a query-only config omits `rpcUrl`, so it keys differently from a signing client and the common case is safe.

```ts
import { createConfig, createManifestReadClient } from '@manifest-network/manifest-sdk';

const config = createConfig({
  chainId: 'manifest-1',
  rpcUrl: 'https://rpc.manifest.example/',
  gasPrice: '0.01umfx', // required when rpcUrl is set
});

const read = await createManifestReadClient({ config });
const balance = await read.getBalance('manifest1abc…');
read.dispose();
```

## Wallets — the `WalletProvider` port

Signing happens at the edge: you pass a `WalletProvider`, and the SDK never sees key material. The interface is small — `getAddress`, `getSigner`, and (for provider auth) an optional `signArbitrary`.

**Node** — use the bundled `MnemonicWalletProvider` (two-arg: config, then mnemonic):

```ts
import { MnemonicWalletProvider } from '@manifest-network/manifest-sdk';

const walletProvider = new MnemonicWalletProvider(config, process.env.MANIFEST_MNEMONIC!);
```

**Browser** — wrap your wallet adapter's offline signer. `cosmos-kit` exposes `signArbitrary` as a *separate* hook value (not a method on the signer), so thread it in directly:

```ts
import type { WalletProvider } from '@manifest-network/manifest-sdk';
import { useChain } from '@cosmos-kit/react';

const { address, getOfflineSigner, signArbitrary } = useChain('manifest');

const walletProvider: WalletProvider = {
  getAddress: async () => address,
  getSigner: async () => getOfflineSigner(),
  signArbitrary, // ADR-036 — required for the Fred provider lifecycle
};
```

`signArbitrary` is optional on the interface because not every flow needs it: chain reads and transactions don't, but the Fred provider endpoints (`deployApp`, `appStatus`, …) authenticate with ADR-036 tokens minted from it.

## Reads

Every read is a bound method on all three clients. Branded ids the SDK returns are already typed; you only `parse*` ids that arrive from outside.

```ts
import { LeaseState } from '@manifest-network/manifest-sdk/deploy';

const balance = await client.getBalance(address);
const skus = await client.getSKUs({});
const leases = await client.getLeasesByTenant({ tenant: address, stateFilter: LeaseState.LEASE_STATE_ACTIVE });
const lease = await client.getLease(leaseUuid); // leaseUuid: string | LeaseUuid
```

The full set — `getBalance`, `getLease`, `getLeasesByTenant`, `getSKUs`, `getProviders`, `getLeaseByCustomDomain`, `getBillingParams`, `getWithdrawableAmount`, `resolveSku`, `listSkuCandidates` — is also exported as free `fn(ctx, input)` functions from `@manifest-network/manifest-sdk/reads` for when you want to tree-shake a single read without the client.

## Transactions

The on-chain tx methods live on the signing clients. `parse*` untrusted input at the boundary:

```ts
import { parseFqdn } from '@manifest-network/manifest-sdk';

await client.fundCredits({ amount: '5000000upwr' });

await client.setItemCustomDomain({
  leaseUuid,                          // already branded (from deployApp) — no cast
  customDomain: parseFqdn(userInput), // throws INVALID_ARGUMENT on a bad FQDN
  serviceName: 'web',                 // omit for single-service leases; pass { clear: true } to release
});

await client.stopApp({ leaseUuid });
```

### Batching: `executeTx`

`executeTx` puts multiple messages in **one atomic transaction** (all-or-nothing), and serializes broadcasts per signer so sequences can't nonce-clash. Messages are standard `EncodeObject`s built from `manifestjs` codecs:

```ts
import type { EncodeObject } from '@manifest-network/manifest-sdk/deploy';
import { MsgFundCredit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js';

const fund = (amount: string): EncodeObject => ({
  typeUrl: '/liftedinit.billing.v1.MsgFundCredit',
  value: MsgFundCredit.fromPartial({ sender: address, tenant: address, amount: { denom: 'upwr', amount } }),
});

await client.executeTx([fund('1000'), fund('2000')]); // one tx, two messages
```

## Deploying an app

`client.deployApp` is the canonical path — one call creates the lease, uploads the manifest, and waits until the provider reports ready. Pass `image` + `port` for a single service, or `services` for a stack (never both):

```ts
// Single service
const { lease_uuid, provider_url, state } = await client.deployApp({
  image: 'nginxinc/nginx-unprivileged:alpine',
  port: 8080,
  size: 'docker-micro',          // an SKU tier — discover via client.getSKUs({})
  env: { LOG_LEVEL: 'info' },     // optional
  customDomain: 'app.example.com', // optional — claims the FQDN on the new lease
});

// Multi-service stack
await client.deployApp({
  services: {
    web: { image: 'nginxinc/nginx-unprivileged:alpine', ports: { '8080/tcp': {} } },
    db: { image: 'postgres:16', ports: { '5432/tcp': {} }, env: { POSTGRES_PASSWORD: '…' } },
  },
  size: 'docker-micro',
  customDomain: 'app.example.com',
  serviceName: 'web', // which service the domain points at (required for stacks)
});
```

The result carries the branded `lease_uuid`, the `provider_uuid` / `provider_url`, the `state`, and (best-effort) `connection` info.

**Partial-success errors.** If the create-lease tx succeeds but a later step fails (set-domain, upload, or the readiness poll), `deployApp` throws a `ManifestMCPError` whose message is prefixed `Deploy partially succeeded:` and whose `details.lease_uuid` is the orphaned lease — close it with `client.stopApp({ leaseUuid })`:

```ts
import { ManifestMCPError, type LeaseUuid } from '@manifest-network/manifest-sdk';

try {
  await client.deployApp(spec);
} catch (err) {
  if (err instanceof ManifestMCPError && typeof err.details?.lease_uuid === 'string') {
    await client.stopApp({ leaseUuid: err.details.lease_uuid as LeaseUuid });
  }
  throw err;
}
```

> **Escape hatch.** The same `deployApp` is also exported as a free `fn(ctx, spec, opts)` from `/deploy` for advanced composition, but it requires you to assemble a `FredAuthCtx` (with a `providerAuth` token provider) by hand. Prefer the bound `client.deployApp` — it reuses the client's own `providerAuth`. Smoother re-exports for the free-fn path are tracked in [ENG-446](https://linear.app/liftedinit/issue/ENG-446).

## Watching live status

`subscribeLeaseStatus` is a poll-backed **converging watch**: it always ends in exactly one of `onComplete` (a terminal state) or `onError`, and returns a synchronous unsubscribe. The options object is required.

```ts
const unsubscribe = client.subscribeLeaseStatus(leaseUuid, {
  onData: (status) => console.log(status.state),
  onComplete: (final) => console.log('settled:', final.state),
  onError: (err) => console.error(err),
  timeout: 120_000,
});
// later: unsubscribe();
```

## Catalog and SKU resolution

```ts
const catalog = await client.browseCatalog();           // providers + SKUs + health, one call
const ready = await client.checkDeploymentReadiness({ size: 'docker-micro', image: 'nginx:1.25' });
```

When a tier name maps to more than one provider's SKU, `resolveSku` throws `ManifestMCPErrorCode.SKU_AMBIGUOUS` with `details.candidates` — render a picker, then re-deploy pinning `skuUuid` + `providerUuid` on the spec. `client.listSkuCandidates(...)` is the no-throw listing. These also live as free fns on `@manifest-network/manifest-sdk/catalog`.

## Building manifests

If you build the manifest yourself (e.g. a UI editor) rather than letting `deployApp` derive it, the builders are on `/deploy`:

```ts
import { buildManifest, buildStackManifest, mergeManifest, validateManifest } from '@manifest-network/manifest-sdk/deploy';

const manifest = buildManifest({ image: 'nginx:1.25', ports: { '80/tcp': {} }, env: { FOO: 'bar' } });
```

`mergeManifest` applies UI-shaped edits onto an existing manifest while preserving fields the editor doesn't touch; `validateManifest` / `parseStackManifest` / `getServiceNames` support preview UIs.

## `fetch` injection, CORS, and the SSRF guard

Every client takes an optional `fetch`. It defaults to `globalThis.fetch`; inject your own to add a CORS proxy (browser dev) or the SSRF guard (Node):

```ts
import { createGuardedFetch } from '@manifest-network/manifest-sdk/node'; // node-only subpath

const client = await createFredClient({ config, walletProvider, fetch: createGuardedFetch() });
```

Provider URLs come from on-chain SKU records, so a **Node** consumer should guard provider HTTP (the browser sandbox/CORS already does). Omitting `fetch` in Node leaves it unguarded; a node-default convenience factory is tracked in [ENG-444](https://linear.app/liftedinit/issue/ENG-444).

## Errors

Everything throws `ManifestMCPError` with a `code` from `ManifestMCPErrorCode` (e.g. `INVALID_ARGUMENT`, `SKU_AMBIGUOUS`, `TX_FAILED`, `OPERATION_CANCELLED`). Transient failures (network, 5xx, 429) are auto-retried; permanent ones bubble up. Branch on `code`, not message text. Before logging an error's `details`, pass it through `sanitizeForLogging` (exported from the root) to redact sensitive fields.

## Orchestration tier (optional)

`@manifest-network/manifest-sdk/orchestration` adds plan → confirm → recover flows on top of the capability tier (`deployApp`, `manageDomain`, `closeLease`, `troubleshootDeployment`). These are **callback-driven** — `fn(input, callbacks, opts)` with `onPlan` / `onConfirm` / `onProgress` — a different shape from the capability tier's `fn(ctx, input)`, so the host can drive a human-in-the-loop UI. Most apps compose the capability tier directly and don't need this.

## Low-level escape hatch

For raw chain access beyond the typed surface, the root re-exports `CosmosClientManager` (the keyed connection manager) — though for raw on-chain message broadcasting, prefer `executeTx`, which is typed and handles atomicity/serialization.

> The stringly, JSON-shaped `cosmos_query` / `cosmos_tx` operations are **not** part of this SDK — they're the MCP-server face in the separate `@manifest-network/manifest-mcp-{chain,lease,fred}` packages, for LLM/agent hosts.

## Faucet

Funding a brand-new wallet's gas is out of SDK scope today; the faucet client lives in the `@manifest-network/manifest-mcp-chain` package (`requestFaucet`, `requestFaucetCredit`, `fetchFaucetStatus`) if you need an in-app top-up affordance.

## Browser quirks

- Don't import `@manifest-network/manifest-sdk/node` (or `…/manifest-mcp-node`) in a browser bundle — `/node` is mapped so a browser bundler fails fast rather than pulling Node builtins.
- Many chain fields (heights, gas, supply) round-trip as `bigint`; `bigIntReplacer` (from the root) is a safe `JSON.stringify` replacer.
- The browser blocks cross-origin `fetch` by default — run a CORS proxy in dev or push provider calls server-side, and pass your CORS-aware `fetch` to the client so URL validation stays intact.

## Stable vs internal exports

The SDK barrel and its documented subpaths are the public, semver-versioned surface. Don't reach into `dist/` deep paths or the underlying `manifest-mcp-*` packages' internals — if something you need isn't re-exported, [open an issue](https://github.com/manifest-network/manifest-mcp-mono/issues).
