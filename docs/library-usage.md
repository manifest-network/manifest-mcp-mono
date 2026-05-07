# Library usage

Most users wire the MCP servers up through the four CLI binaries (see [`packages/node/README.md`](../packages/node/README.md)). But every package also exports its public API for consumers that want to call the same logic from inside their own application — typically a TypeScript app that doesn't speak the MCP protocol but still needs to talk to the Manifest chain or a Fred provider.

The reference consumer is **Barney**, the Manifest web frontend, which imports `@manifest-network/manifest-mcp-core`, `…-chain`, and `…-fred` to drive the chain and providers directly without an MCP host. The patterns below are the ones Barney actually uses.

> **Browser compatibility.** `core`, `chain`, `lease`, `fred`, and `cosmwasm` are all built with `tsdown`'s `platform: "neutral"` target and avoid Node-specific APIs. The exception is the `node` package itself (CLI bootstrap, keyfile decryption, `dotenv`) — that one is `platform: "node"` and won't bundle for the browser. Use `core` + a wallet from `cosmos-kit` / Keplr / Leap / Web3Auth for browser apps.

## When to use the library form

| Goal | Library form is right when… |
|------|----------------------------|
| Run a chain query/transaction inside a custom app | You don't need MCP framing. Use `cosmosQuery` / `cosmosTx` from core directly. |
| Drive a deployment from a web UI | You want the same orchestration `deploy_app` performs but inside your own UI. Compose `cosmosTx('billing', 'create-lease', …)` with `uploadLeaseData` (provider) and `pollLeaseUntilReady` (fred) yourself, the way Barney does, or call the high-level `deployApp` helper. |
| Talk to a Fred provider from a service | Import the `http/*` exports from the fred package. They take an optional `fetchFn` so you can inject a CORS proxy / SSRF-validating fetch. |
| Build a custom MCP server with extra tools | Compose `core` (Cosmos logic) + your own `McpServer` instance from `@modelcontextprotocol/sdk`. |

## Wallet bootstrap

In Node.js, use `MnemonicWalletProvider` from core. In the browser, plug in any wallet that satisfies the `WalletProvider` interface — Barney wraps `cosmos-kit`'s offline signer in a thin custom class. Note that `cosmos-kit` exposes `signArbitrary` as a *separate* hook return value (not a method on the offline signer); you'd thread it through your app independently of the `WalletProvider` and pass it into the ADR-036 helpers below.

```ts
// barney/src/hooks/useManifestMCP.ts (paraphrased)
import {
  CosmosClientManager,
  type ManifestMCPConfig,
  type WalletProvider,
} from '@manifest-network/manifest-mcp-core';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { useChain } from '@cosmos-kit/react';

class CosmosKitWalletProvider implements WalletProvider {
  constructor(
    private signer: OfflineSigner,
    private address: string,
  ) {}
  async getAddress() { return this.address; }
  async getSigner() { return this.signer; }
  // No signArbitrary on this class — cosmos-kit returns it separately
  // from useChain(). See "ADR-036 auth token construction" below.
}

const { address, isWalletConnected, getOfflineSigner, signArbitrary } = useChain('manifest');
const wallet = new CosmosKitWalletProvider(getOfflineSigner(), address);

const config: ManifestMCPConfig = {
  chainId: 'manifest-1',
  rpcUrl: 'https://your-rpc-endpoint/',
  gasPrice: '0.01umfx',
  addressPrefix: 'manifest',
};

const clientManager = CosmosClientManager.getInstance(config, wallet);
// Keep `signArbitrary` around (Barney stores it in a Zustand slice) and
// pass it into the auth-token helpers wherever they're called.
```

`CosmosClientManager.getInstance` is keyed by `chainId:rpcUrl[:restUrl]` and reused across calls. There's no advantage to caching the result yourself. When the wallet disconnects, call `clientManager.disconnect()` so the underlying signing client is torn down.

> **Why `signArbitrary` is separate.** The `WalletProvider` interface declares it as `signArbitrary?(address, data)` (optional method). Some wallets (`MnemonicWalletProvider` and `KeyfileWalletProvider`) implement it on the provider directly because they own the seed; cosmos-kit doesn't, because the underlying browser wallet (Keplr/Leap/etc.) exposes the operation through a different hook surface. Both shapes work — the helpers below take a callable, not a `WalletProvider`.

## Generic Cosmos SDK queries and transactions

Both functions take **positional args** (not an options object):

```ts
import {
  cosmosQuery,
  cosmosTx,
  cosmosEstimateFee,
} from '@manifest-network/manifest-mcp-core';

// Read — args[] mirrors the CLI args for the (module, subcommand) pair
const balances = await cosmosQuery(
  clientManager,
  'bank',
  'balances',
  [tenantAddress],
);

// Estimate fee before broadcasting
const estimate = await cosmosEstimateFee(
  clientManager,
  'bank',
  'send',
  ['manifest1xyz...', '50000000umfx'],
  // optional: { gasMultiplier: 1.8 }
);

// Write — set waitForConfirmation=true to wait for inclusion past the broadcast ack
const result = await cosmosTx(
  clientManager,
  'billing',
  'close-lease',
  [leaseUuid],
  /* waitForConfirmation */ true,
  // optional: { gasMultiplier: 1.8 }
);
```

Errors thrown from these are `ManifestMCPError` instances; check `error.code` against `ManifestMCPErrorCode`. Transient failures (network, 5xx, 429) are auto-retried; permanent failures bubble up immediately.

## On-chain helpers

Each of these wraps a `cosmosTx` with the right module + subcommand and a normalized result shape. Signatures are positional with optional trailing parameters:

```ts
import {
  fundCredits,         // fundCredits(clientManager, amount, overrides?, tenant?)
  getBalance,          // getBalance(queryClient, address)
  setItemCustomDomain, // setItemCustomDomain(clientManager, leaseUuid, customDomain, options?, overrides?)
  stopApp,             // stopApp(clientManager, leaseUuid, overrides?)
} from '@manifest-network/manifest-mcp-core';

// On-chain wallet balance + credit-account balance + credit estimate, in one call
const queryClient = await clientManager.getQueryClient();
const balance = await getBalance(queryClient, address);

// Send tokens to a billing credit account (defaults to your own; pass tenant to fund someone else's)
await fundCredits(clientManager, '10000000umfx');

// Claim an FQDN on an existing lease item
await setItemCustomDomain(
  clientManager,
  leaseUuid,
  'app.example.com',
  { serviceName: 'web' }, // omit for legacy single-item leases; pass { clear: true } to clear
);

// Close a lease
await stopApp(clientManager, leaseUuid);
```

Note `getBalance` takes a `queryClient` (the manifestjs RPC client), not a `clientManager`. Get one with `await clientManager.getQueryClient()`.

## Fred HTTP clients with `fetchFn` injection

Every HTTP-issuing function in `packages/fred/src/http/{fred,provider}.ts` accepts an optional `fetchFn?: typeof globalThis.fetch` parameter. In most signatures it's the last argument; the one exception is `uploadLeaseData(providerUrl, leaseUuid, payload, authToken, fetchFn?, abortSignal?)`, where `abortSignal` follows it. When `fetchFn` is omitted, the global `fetch` is used. When supplied, the function calls your fetch instead. This is the seam Barney uses to route requests through its CORS proxy in dev and through an SSRF validator in prod:

```ts
// barney/src/api/providerFetchAdapter.ts (excerpt)
export const providerFetch = createProviderFetch();

// barney/src/api/fred.ts (excerpt)
import {
  getLeaseStatus as fredGetLeaseStatus,
  uploadLeaseData as fredUploadLeaseData,
} from '@manifest-network/manifest-mcp-fred';
import { providerFetch } from './providerFetchAdapter';

export function getLeaseStatus(providerUrl: string, leaseUuid: string, authToken: string) {
  return fredGetLeaseStatus(providerUrl, leaseUuid, authToken, providerFetch);
}
export function uploadLeaseData(
  providerUrl: string,
  leaseUuid: string,
  payload: Uint8Array,
  authToken: string,
) {
  return fredUploadLeaseData(providerUrl, leaseUuid, payload, authToken, providerFetch);
}
```

In a Node service or test, the same seam is how you inject a mock fetch.

The functions that accept `fetchFn` are: `getLeaseStatus`, `getLeaseLogs`, `getLeaseProvision`, `getLeaseReleases`, `getLeaseInfo`, `restartLease`, `updateLease`, `pollLeaseUntilReady`, `getProviderHealth`, `getLeaseConnectionInfo`, `uploadLeaseData`. The high-level `deployApp`, `appStatus`, `browseCatalog`, `waitForAppReady`, `getAppLogs`, `restartApp`, and `updateApp` helpers all forward a `fetchFn` to the underlying calls. (`checkDeploymentReadiness` and `buildManifestPreview` don't issue HTTP — they're chain-only or pure — so they don't take `fetchFn`.)

## ADR-036 auth token construction

Every fred HTTP call to a *protected* provider endpoint expects a `Bearer <token>` header. Tokens are constructed entirely client-side; there's no auth-endpoint round-trip.

The fred package exposes two strategies — pick one.

### Strategy A: hand-roll the token (Barney's pattern)

`signArbitrary` here is whatever your wallet returns for ADR-036 signing — for `MnemonicWalletProvider` and `KeyfileWalletProvider` that's `wallet.signArbitrary` (optional method on the provider); for cosmos-kit that's the standalone function returned from `useChain()`. The helpers don't care which — they just need a callable that returns `{ pub_key: { type, value }, signature }`.

```ts
import {
  createSignMessage,
  createLeaseDataSignMessage,
  createAuthToken,
} from '@manifest-network/manifest-mcp-fred';

type SignArbitraryFn = (
  signer: string,
  data: string,
) => Promise<{ pub_key: { type: string; value: string }; signature: string }>;

// signArbitrary comes from useChain() (cosmos-kit) or wallet.signArbitrary.bind(wallet) (mnemonic/keyfile)
async function buildToken(signArbitrary: SignArbitraryFn, tenant: string, leaseUuid: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = createSignMessage(tenant, leaseUuid, timestamp);
  const { pub_key, signature } = await signArbitrary(tenant, message);
  return createAuthToken(tenant, leaseUuid, timestamp, pub_key.value, signature);
}
// pass: Authorization: Bearer ${await buildToken(...)}
```

For lease-data uploads (e.g. uploading a manifest during deploy), call `createLeaseDataSignMessage(leaseUuid, metaHashHex, timestamp)` instead and pass `metaHashHex` as the last arg of `createAuthToken`. The provider rejects a generic token on the upload endpoint and vice versa.

> **Replay protection.** The provider enforces a 30 s max token age and per-signature replay detection on protected endpoints. ADR-036 signing is deterministic: two calls that share a timestamp produce identical signatures. If you issue tokens in tight loops (Barney does, polling status during deploy), wrap timestamp generation in a small helper that waits for the wall clock to advance past the previously-issued value before returning — so two consecutive `Math.floor(Date.now() / 1000)` calls never collide.

### Strategy B: pass a `getAuthToken` callback to the high-level helpers

`deployApp`, `appStatus`, `getAppLogs`, `restartApp`, `updateApp`, `waitForAppReady` take a `getAuthToken: (address, leaseUuid) => Promise<string>` callback (and `deployApp` additionally takes `getLeaseDataAuthToken: (address, leaseUuid, metaHashHex) => Promise<string>` for the upload step). Build the callback once and reuse it:

```ts
import { createAuthToken, createSignMessage, createLeaseDataSignMessage } from '@manifest-network/manifest-mcp-fred';

// `signArbitrary` is the same callable described under Strategy A —
// `wallet.signArbitrary.bind(wallet)` for mnemonic/keyfile wallets, or
// the standalone function returned from cosmos-kit's `useChain()`.
const getAuthToken = async (address: string, leaseUuid: string) => {
  const ts = await nextMonotonicTimestamp(); // your wall-clock helper from the note above
  const msg = createSignMessage(address, leaseUuid, ts);
  const { pub_key, signature } = await signArbitrary(address, msg);
  return createAuthToken(address, leaseUuid, ts, pub_key.value, signature);
};

const getLeaseDataAuthToken = async (address: string, leaseUuid: string, metaHashHex: string) => {
  const ts = await nextMonotonicTimestamp();
  const msg = createLeaseDataSignMessage(leaseUuid, metaHashHex, ts);
  const { pub_key, signature } = await signArbitrary(address, msg);
  return createAuthToken(address, leaseUuid, ts, pub_key.value, signature, metaHashHex);
};
```

## Fred high-level helpers

These mirror the MCP `deploy_app` / `app_status` / `update_app` / etc. tools. Signatures use a mix of positional args and a final options object — exactly as exported, **not** the named-options shape the MCP tool inputs use:

```ts
import {
  appStatus,           // (queryClient, address, leaseUuid, getAuthToken, fetchFn?)
  browseCatalog,       // (queryClient, fetchFn?)
  buildManifestPreview, // (input)  -- pure, no chain access
  checkDeploymentReadiness, // (queryClient, address, input?)
  deployApp,           // (clientManager, getAuthToken, getLeaseDataAuthToken, input, fetchFn?)
  getAppLogs,          // (queryClient, address, leaseUuid, getAuthToken, tail?, fetchFn?)
  restartApp,          // (queryClient, address, leaseUuid, getAuthToken, fetchFn?)
  updateApp,           // (queryClient, address, leaseUuid, getAuthToken, manifest, existingManifest?, fetchFn?)
  waitForAppReady,     // (queryClient, address, leaseUuid, getAuthToken, opts?, fetchFn?)
} from '@manifest-network/manifest-mcp-fred';

const queryClient = await clientManager.getQueryClient();
const address = await wallet.getAddress();

// 1. Pre-flight (no signing)
const readiness = await checkDeploymentReadiness(queryClient, address, {
  size: 'docker-micro',
  image: 'nginx:1.25',
});

// 2. Preview (no chain access)
const preview = await buildManifestPreview({ image: 'nginx:1.25', port: 80 });
if (!preview.validation.valid) throw new Error(preview.validation.errors.join('; '));

// 3. Deploy (broadcasts a TX, takes a paid lease)
const result = await deployApp(
  clientManager,
  getAuthToken,
  getLeaseDataAuthToken,
  {
    image: 'nginx:1.25',
    port: 80,
    size: 'docker-micro',
    // optional hooks: abortSignal, onLeaseCreated, onProgress, checkChainState, pollOptions
  },
  providerFetch, // optional fetchFn override
);

// 4. Wait until ready
await waitForAppReady(
  queryClient,
  address,
  result.lease_uuid,
  getAuthToken,
  { timeoutMs: 300_000, intervalMs: 3_000 },
  providerFetch,
);
```

If steps 4-5 fail after a successful `create-lease`, the error from `deployApp` is a `TerminalChainStateError` (when chain state went terminal) or wraps the live `lease_uuid` so you can either retry the upload or close the orphaned lease with `stopApp(clientManager, leaseUuid)`.

## Manifest construction (from outside fred)

If you're rolling your own deploy flow rather than calling `deployApp`, you'll want the manifest builders directly:

```ts
// barney/src/ai/manifest.ts pattern
import {
  buildManifest,
  mergeManifest,
  validateServiceName,
  metaHashHex,
  type BuildManifestOptions,
} from '@manifest-network/manifest-mcp-fred';

const manifest = buildManifest({
  image: 'nginx:1.25',
  ports: { '80/tcp': {} },          // Record<"<port>/<proto>", {}>
  env: { FOO: 'bar' },               // Record<string, string>
});

const json = JSON.stringify(manifest);
const meta = await metaHashHex(json);  // takes the JSON string directly

// Hand the bytes + meta_hash to your create-lease tx, then upload with uploadLeaseData
```

For multi-service stacks use `buildStackManifest` instead, and `mergeManifest` to apply UI-shaped edits onto an existing manifest while preserving fields the editor doesn't touch. `parseStackManifest`, `isStackManifest`, `getServiceNames`, `validateServiceName`, and `validateManifest` are also exported for editor / preview UIs.

## Faucet from the chain package

```ts
import {
  requestFaucet,
  requestFaucetCredit,
  fetchFaucetStatus,
} from '@manifest-network/manifest-mcp-chain';

const status = await fetchFaucetStatus(faucetBaseUrl);
const result = await requestFaucet(faucetBaseUrl, address /* , denom? */);
```

`requestFaucetCredit` is the lower-level call against `/credit`; `requestFaucet` wraps it for the "give me everything" common case. Both are exported so a custom UI can render its own "top up" affordance without going through the MCP `request_faucet` tool.

## Stable vs internal exports

What's exported from each package's `index.ts` is the public surface and is versioned semver-style. Internal layouts (the split into `server/register-*.ts` and `tools/*.ts` inside fred, the per-module files inside core's `queries/` and `transactions/`) are not stable — don't reach in via deep paths. If you need something that isn't re-exported from the package entry, file an issue.

## Browser quirks

- `platform: "neutral"` keeps these packages off `node:fs`, `node:os`, `node:crypto`'s sync APIs, etc. The keyfile wallet (`KeyfileWalletProvider`) is in the `node` package precisely because it touches `fs` — don't import from `@manifest-network/manifest-mcp-node` in a browser bundle.
- `dotenv` is also node-only; load env config however your bundler does it (Vite's `import.meta.env`, rsbuild's environment plugin, etc.).
- `bigIntReplacer` is exported from core; use it when stringifying chain responses, since many fields (heights, gas, supply totals) round-trip as `bigint`.
- The browser's `fetch` blocks cross-origin requests by default. If your frontend talks to providers directly, either run a CORS proxy in dev (Barney's pattern), set up CORS allowlists on the provider, or push the calls server-side. Pass your CORS-aware fetch as `fetchFn` to keep the package's URL validation intact.
