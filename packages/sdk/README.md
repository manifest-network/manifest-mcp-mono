# @manifest-network/manifest-sdk

The app-building SDK for [Manifest Network](https://www.manifestai.com/) + the Fred deployment platform. Build a full application — query the chain, deploy and manage containerized apps, claim custom domains, batch transactions, watch live status — by composing **only** this package and [`manifestjs`](https://www.npmjs.com/package/@manifest-network/manifestjs). It aggregates `@manifest-network/manifest-mcp-core`, `@manifest-network/manifest-mcp-fred`, and `@manifest-network/manifest-agent-core` behind one typed surface.

```bash
npm install @manifest-network/manifest-sdk @manifest-network/manifestjs
```

## Quickstart

Create a client, then call its methods. `createFredClient` returns a fully-wired client — chain reads/writes **plus** the Fred provider operations — with the ports threaded for you.

```ts
import {
  createConfig,
  createFredClient,
  MnemonicWalletProvider,
} from '@manifest-network/manifest-sdk';

const config = createConfig({
  chainId: 'manifest-1',
  rpcUrl: 'https://rpc.manifest.example/',
  gasPrice: '0.01umfx',
});

// A funded Manifest wallet. NEVER hard-code a real mnemonic — load it from your env/secret store.
const walletProvider = new MnemonicWalletProvider(config, process.env.MANIFEST_MNEMONIC!);

const client = await createFredClient({ config, walletProvider });

try {
  // Read — browse the provider catalog (no signing)
  const catalog = await client.browseCatalog();

  // Deploy — one bound call: create the lease, upload the manifest, wait until ready
  const { lease_uuid, provider_url } = await client.deployApp({
    image: 'nginxinc/nginx-unprivileged:alpine',
    port: 8080,
    size: 'docker-micro',
  });

  // Read it back
  const lease = await client.getLease(lease_uuid);
} finally {
  // Always dispose — clients with the same config share (and mutate) one underlying
  // connection; don't hold two against one config key at once (see the cookbook).
  client.dispose();
}
```

> **Prerequisites.** Deploying broadcasts on-chain transactions and takes a paid lease, so the wallet above must be **funded** with gas (and billing credit — see the [cookbook](../../docs/library-usage.md)). For a read-only app, use `createManifestReadClient(...)`, which needs no wallet.

**In the browser** (the reference consumer, [Barney](../../docs/library-usage.md), is a web app), supply a `WalletProvider` that wraps your wallet adapter instead of `MnemonicWalletProvider`:

```ts
// cosmos-kit / Keplr / Leap — wrap the offline signer in the WalletProvider port
const walletProvider: WalletProvider = {
  getAddress: async () => address,
  getSigner: async () => getOfflineSigner(),
  signArbitrary, // from useChain() — needed for provider (ADR-036) auth
};
```

## The typed app face

The SDK is the **single typed library face** for building on Manifest. You reach for two complementary shapes, both fully typed:

- **The bound client** (`createFredClient` / `createManifestClient` / `createManifestReadClient`) — the everyday surface. Methods like `client.deployApp(...)`, `client.getSKUs(...)`, `client.executeTx(...)` close over the ports for you.
- **Scoped free functions** on subpaths (`/reads`, `/catalog`, `/deploy`, `/orchestration`) — `fn(ctx, input)` building blocks for when you want to compose or tree-shake a single capability without the whole client.

> The stringly, JSON-shaped `cosmos_query` / `cosmos_tx` tools you may have seen are the **MCP-server** face — they live in the separate `@manifest-network/manifest-mcp-{chain,lease,fred}` packages for LLM/agent hosts and are **not** part of this SDK. For a low-level on-chain escape hatch *from the SDK*, use `executeTx` (multi-message atomic tx, from `/deploy`) or drop down to `CosmosClientManager` (re-exported from the root); the typed `cosmosQuery` / `cosmosTx` primitives behind those tools are on `…/chain` as raw query/tx escape hatches.

For a **read** the SDK doesn't wrap, you don't need a second manifestjs client — the read client exposes manifestjs's own typed query tree at **`client.query`** (`fromJSON`-converted, so enums are numeric; note it bypasses the rate limiter, so prefer a typed read where one exists). Use it for 1:1 passthroughs like `client.query.liftedinit.billing.v1.creditAddress({ tenant })` or `client.query.cosmos.bank.v1beta1.balance({ address, denom })`. See the [cookbook](../../docs/library-usage.md#raw-manifestjs-queries--clientquery).

## Parse at the edges

Domain values are branded types (`Address`, `LeaseUuid`, `ProviderUuid`, `SkuUuid`, `Fqdn`). Parse **untrusted** input at the boundary with the throwing `parse*` constructors; values the SDK already returns are branded, so you never re-cast them.

```ts
import { parseFqdn } from '@manifest-network/manifest-sdk';

// `userDomain` came from a form / CLI arg — validate it before it crosses the boundary
await client.setItemCustomDomain({
  leaseUuid: lease_uuid,                 // already a LeaseUuid (from deployApp) — no cast
  customDomain: parseFqdn(userDomain),   // throws INVALID_ARGUMENT on a bad FQDN
  serviceName: 'web',
});
```

## Typed errors

Most failures throw `ManifestMCPError` (with a `code` from `ManifestMCPErrorCode`); the exception is provider HTTP failures, which throw a separate `ProviderApiError` that carries `status`, **not** a `code`. Both error shapes carry typed detail — prefer the exported guards over `instanceof` (unreliable across duplicate package copies):

- **`isSkuAmbiguousError(err)`** narrows `err.details` to `{ reason: 'AMBIGUOUS_SKU_NAME', size, candidates }` when a SKU name matched more than one active SKU — render a picker from `candidates`.
- **`ProviderApiError.isProviderApiError(err)`** is a dual-package-safe brand guard for provider HTTP errors (exposes `err.status`).

See the [cookbook](../../docs/library-usage.md#errors) for a worked example.

## Node consumers: keep the SSRF guard on

Provider URLs come from on-chain SKU records, so provider HTTP on **Node** should run through an SSRF-guarded `fetch` — it blocks requests to internal hosts *before they're sent*. The base `createFredClient` does **not** guard *at connect time* by default (it can't — the barrel stays browser-safe), so on Node it emits a one-time warning.

Independently of that connect-time guard, provider-URL **string** validation is always on and works in the browser too: `validateProviderUrl` default-denies a provider `apiUrl` that is a literal private/internal/loopback/metadata IP (ENG-490). Use the exported `isUrlSsrfSafe` for URLs you validate yourself — notably a provider **WebSocket** URL (`wss://…`) in the **browser**, where the native `WebSocket` has no connect-time guard. (On **Node**, `createFredClientNode` now runs the live-status WebSocket through an SSRF-guarded `ws` transport as well — see `createNodeEventTransport`.) The string layer fails open on DNS *hostnames* (only the Node connect guard / the browser's Private Network Access can catch a hostname that resolves internally), so it is defense-in-depth, not a rebinding-proof guard. Use **`createFredClientNode`** from the `/node` subpath, which is SSRF-safe by default:

```ts
import { createFredClientNode } from '@manifest-network/manifest-sdk/node';

const client = await createFredClientNode({ config, walletProvider }); // provider HTTP is guarded
```

Injecting your own `fetch` opts **out** of the guard (a plain `globalThis.fetch` is still unguarded) — wrap `createGuardedFetch()` from `/node` if you need to compose behavior. (Browsers don't need this: same-origin/CORS limits reading a cross-origin *response*, so the request-level guard is a Node concern. The `MANIFEST_FRED_FETCH_GUARDED` env knob is MCP-server-only; the library escape hatch is `opts.fetch`.)

## Subpath map

The root barrel carries the client factories, branded types (`parse*` / `as*`), the ports, the error vocabulary, and config; the free functions live on scoped, tree-shakable subpaths.

| Import | What's there |
|--------|--------------|
| `@manifest-network/manifest-sdk` | Client factories (`createFredClient`, `createManifestClient`, `createManifestReadClient`), brands + `parse*`/`as*`, ports (`WalletProvider`, `Signer` adapters), the error vocabulary (`ManifestMCPError`/`ManifestMCPErrorCode` + the typed guards `ProviderApiError`/`isSkuAmbiguousError`), `createConfig`, and the wholesale type surface (barrel `createFredClient` is unguarded on Node — prefer `createFredClientNode` from `/node`) |
| `…/reads` | Branded read fns: `getBalance`, `getLease`, `getLeasesByTenant`, `getSKUs`, `getProviders`, `getLeaseByCustomDomain`, `getBillingParams`, `getWithdrawableAmount` |
| `…/catalog` | `browseCatalog`, `resolveSku`, `listSkuCandidates`, `checkDeploymentReadiness`, `buildManifestPreview` |
| `…/deploy` | `deployApp`, `restartApp`, `updateApp`, `getAppLogs`, `appStatus`, `waitForAppReady`, `waitForLeaseStatus`, `isLeaseFailureTerminal`, `executeTx`, `fundCredits`, `setItemCustomDomain`, `stopApp`, `LeaseState`, `validateProviderUrl` + `isUrlSsrfSafe` (SSRF-classify a provider URL / WebSocket URL), manifest builders, ADR-036 auth helpers + the deploy-family types (`BuildManifestOptions`, `DeployResult`, `ManifestDeploySpec`, `TxCallOptions`) |
| `…/orchestration` | Optional plan/confirm/recover flows: `deployApp`, `manageDomain`, `closeLease`, `troubleshootDeployment` (callback-driven) |
| `…/chain` | Generic tier-2 chain escape hatches (from **core**, not the `manifest-mcp-chain` server): `cosmosQuery`, `cosmosTx` — the raw query/tx primitives behind the `cosmos_query`/`cosmos_tx` tools |
| `…/faucet` | Testnet faucet ops (browser-safe): `requestFaucet`, `requestFaucetCredit`, `fetchFaucetStatus` (+ `FaucetAccount`/`FaucetDripResult`/`FaucetStatusResponse`/`RequestFaucetResult`). Testnet/operator concern — deliberately off the root barrel |
| `…/node` | Node-only: `createFredClientNode` (SSRF-safe fred client), `createGuardedFetch`, `isBlocked` |

## Full worked example

[`examples/sdk-acceptance`](../../examples/sdk-acceptance) is a runnable, compose-only flow — deploy (single + stack), query, custom domain, atomic batch, live-status poll, stop — built from only this SDK + `manifestjs`, exercised end-to-end against a live chain and bundled for the browser.

## Going further

- **[SDK cookbook](../../docs/library-usage.md)** — wallets, the three client factories, reads/txs, the deploy lifecycle, live status, error handling, and the low-level escape hatch.
- **[CHANGELOG](../../CHANGELOG.md)**
- **[Architecture](../../ARCHITECTURE.md)**

## License

MIT
