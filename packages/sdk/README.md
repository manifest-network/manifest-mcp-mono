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
  // Always dispose — clients keyed by the same config share one underlying connection.
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

> The stringly, JSON-shaped `cosmos_query` / `cosmos_tx` tools you may have seen are the **MCP-server** face — they live in the separate `@manifest-network/manifest-mcp-{chain,lease,fred}` packages for LLM/agent hosts and are **not** part of this SDK. For a low-level on-chain escape hatch *from the SDK*, use `executeTx` (multi-message atomic tx, from `/deploy`) or drop down to `CosmosClientManager` (re-exported from the root).

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

## Node consumers: keep the SSRF guard on

Provider URLs come from on-chain SKU records, so provider HTTP should run through an SSRF-guarded `fetch`. In the browser the sandbox/CORS protects you; in **Node**, inject the guarded fetch from the `/node` subpath:

```ts
import { createGuardedFetch } from '@manifest-network/manifest-sdk/node';

const client = await createFredClient({
  config,
  walletProvider,
  fetch: createGuardedFetch(),
});
```

When `fetch` is omitted it defaults to `globalThis.fetch` (unguarded). A node-default convenience factory is tracked in [ENG-444](https://linear.app/liftedinit/issue/ENG-444).

## Subpath map

The root barrel carries the client factories, branded types (`parse*` / `as*`), the ports, the error vocabulary, and config; the free functions live on scoped, tree-shakable subpaths.

| Import | What's there |
|--------|--------------|
| `@manifest-network/manifest-sdk` | Client factories (`createFredClient`, `createManifestClient`, `createManifestReadClient`), brands + `parse*`/`as*`, ports (`WalletProvider`, `Signer` adapters), `ManifestMCPError`/`ManifestMCPErrorCode`, `createConfig`, and the wholesale type surface |
| `…/reads` | Branded read fns: `getBalance`, `getLease`, `getLeasesByTenant`, `getSKUs`, `getProviders`, `getLeaseByCustomDomain`, `getBillingParams`, `getWithdrawableAmount` |
| `…/catalog` | `browseCatalog`, `resolveSku`, `listSkuCandidates`, `checkDeploymentReadiness`, `buildManifestPreview` |
| `…/deploy` | `deployApp`, `restartApp`, `updateApp`, `getAppLogs`, `appStatus`, `waitForAppReady`, `subscribeLeaseStatus`, `executeTx`, `fundCredits`, `setItemCustomDomain`, `stopApp`, `LeaseState`, manifest builders, ADR-036 auth helpers |
| `…/orchestration` | Optional plan/confirm/recover flows: `deployApp`, `manageDomain`, `closeLease`, `troubleshootDeployment` (callback-driven) |
| `…/node` | Node-only: `createGuardedFetch`, `isBlocked` (SSRF guard) |

## Full worked example

[`examples/sdk-acceptance`](../../examples/sdk-acceptance) is a runnable, compose-only flow — deploy (single + stack), query, custom domain, atomic batch, live-status poll, stop — built from only this SDK + `manifestjs`, exercised end-to-end against a live chain and bundled for the browser.

## Going further

- **[SDK cookbook](../../docs/library-usage.md)** — wallets, the three client factories, reads/txs, the deploy lifecycle, live status, error handling, and the low-level escape hatch.
- **[CHANGELOG](../../CHANGELOG.md)**
- **[Architecture](../../ARCHITECTURE.md)**

## License

MIT
