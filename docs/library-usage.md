# SDK cookbook

[`@manifest-network/manifest-sdk`](../packages/sdk/README.md) is the supported way to build a TypeScript app on Manifest + Fred without speaking the MCP protocol. It aggregates `core` + `fred` + `agent-core` behind one typed surface, so an app composes **only** the SDK and [`manifestjs`](https://www.npmjs.com/package/@manifest-network/manifestjs). The reference consumer is **Barney**, the Manifest web frontend.

This is the deep dive. For a 60-second start, see the [SDK README](../packages/sdk/README.md).

```bash
npm install @manifest-network/manifest-sdk @manifest-network/manifestjs
```

> **Browser compatibility.** The SDK barrel and its universal subpaths are browser-bundleable without unguarded Node-only modules. CosmJS retains a guarded optional `crypto` fallback but uses Web Crypto in browsers. `/node` is mapped to fail fast under browser resolution because it owns the SSRF-guarded transports. `/orchestration` is universal, but its opt-in filesystem operations — `deployApp(spec, callbacks, { dataDir })` manifest persistence and `loadChainDenomMap(path)` — require Node when called. Use a `cosmos-kit` / Keplr / Leap wallet with the universal client and capability subpaths for browser apps.

## Choosing a client

Three factories, all returning a bound client whose methods close over the ports for you. Pick by what you need to do:

| Factory | Needs a wallet? | Gives you |
|---------|-----------------|-----------|
| `createManifestReadClient` | No | Chain **reads** only (`getBalance`, `getLease`, `getSKUs`, …) |
| `createManifestClient` | Yes | Reads **+ on-chain transactions** (`fundCredits`, `setItemCustomDomain`, `stopApp`, `executeTx`) |
| `createFredClient` | Yes | Everything above **+ the Fred provider lifecycle** (`deployApp`, `appStatus`, `getAppLogs`, `restartApp`, `updateApp`, `waitForLeaseStatus`, …) |

All three share the same options (`{ config, fetch?, logger? }` — plus a required `walletProvider` for the two signing factories, and a few not-yet-active `@beta` fields) and the same lifecycle rule: **`dispose()` every client** when you're done. Clients keyed by the same config share one underlying `CosmosClientManager` connection (torn down when the last holder disposes), and `getInstance` *mutates* that shared instance — so don't hold two clients against the **same config key** at once (e.g. a read client and a signing client). In practice a query-only config omits `rpcUrl`, so it keys differently from a signing client and the common case is safe.

```ts
import { createConfig, createManifestReadClient } from '@manifest-network/manifest-sdk';

const config = createConfig({
  chainId: 'manifest-1',
  rpcUrl: 'https://rpc.manifest.example/',
  gasPrice: '0.01umfx', // required when rpcUrl is set
  // A read-only client can instead take a query-only config — `restUrl` alone, no
  // rpcUrl/gasPrice — which keys separately from any signing client on the same chain.
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

The full set — `getBalance`, `getLease`, `getLeasesByTenant`, `getSKUs`, `getProviders`, `getLeaseByCustomDomain`, `getBillingParams`, `getWithdrawableAmount` — is also exported as free `fn(ctx, input)` functions from `@manifest-network/manifest-sdk/reads` for when you want to tree-shake a single read without the client. (`resolveSku` / `listSkuCandidates` are bound on the client too, but as free fns they live on `/catalog` — see *Catalog and SKU resolution* below.)

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

Stack port keys always include the protocol. `host_port` must be omitted (or
`0`) because Fred assigns it dynamically; `ingress: true` selects at most one
TCP port for public routing. `PortConfig` is available from every scoped SDK
subpath that exposes a service input:

```ts
import type {
  PortConfig,
  ServiceConfig,
} from '@manifest-network/manifest-sdk/orchestration';

const publicHttp: PortConfig = { ingress: true };
const web: ServiceConfig = {
  image: 'nginxinc/nginx-unprivileged:alpine',
  ports: { '8080/tcp': publicHttp },
};
```

The result carries the branded `lease_uuid`, the `provider_uuid` / `provider_url`, the `state`, and (best-effort) `connection` info.

**Partial-success errors.** This subsection describes the bound `client.deployApp` path (and the equivalent free function from `/deploy`). Most failures after the create-lease tx are wrapped in a `ManifestMCPError` whose message is prefixed `Deploy partially succeeded:` and whose `details.lease_uuid` names the lease. The outcomes below require different responses:

One opt-in exception is not wrapped: if a caller supplies `pollOptions.checkChainState` and it reports a terminal on-chain state, `deployApp` rethrows `TerminalChainStateError` (a `ProviderApiError`) with `details.lease_uuid` and no partial-success prefix. The chain has already made that lease inactive, so surface the error rather than trying to close the lease again. The recovery sample below intentionally lets this error fall through to its final `throw`.

- **`details.readiness_unconfirmed === true`** — the lease exists, the manifest is uploaded, and the provider never reported a failure. The poll ended without a verdict because of a deadline, an unreachable or rejecting status endpoint, an invalid/oversized response, an authentication failure, cancellation, or another non-verdict error. The app may be starting right now. **Do not close it**: for `DEPLOY_READINESS_UNCONFIRMED`, re-check with `client.appStatus` or wait longer with `waitForAppReady({ timeoutMs })`; for `OPERATION_CANCELLED`, respect the cancellation and retain the lease UUID for later diagnosis. `details.failedStep` is `poll`; `poll_reason` is present only for the typed deadline / provider-unreachable variants.
- **`details.failedStep === 'poll'` without `readiness_unconfirmed`** — polling returned `PROVISION_FAILED`, a terminal provider state, or a state this client cannot interpret. Re-query status before acting and treat `chainState` as authoritative: close when the chain still says ACTIVE and the provider returns a recognized failed `provision_status`; a terminal **on-chain** state is already inactive. A provider terminal state while the chain is ACTIVE is not proof that billing stopped. If its `provision_status` does not confirm failure, preserve and report the mismatch. If the re-query throws, or returns `providerError` without `fredStatus`, preserve the original deploy error and lease for later diagnosis. Never close solely because `failedStep` is `poll`.
- **Set-domain, upload, or pre-step callback failure** — the manifest never reached a running state, so closing the lease is the cleanup if you do not retry the failed step. Treat cleanup as best-effort: if it fails, report that failure separately but preserve the original partial-deploy error and its recovery metadata.

The explicit second `waitForAppReady` below has different error precedence from those best-effort diagnostics and cleanup calls. A failure from this new operation intentionally propagates, but it can fail during its chain/provider pre-flight before observing readiness; those pre-flight errors can carry less recovery context than the original partial-deploy error. Record the already-known lease UUID immediately before the call, as the sample does. If the wait succeeds, the final `throw err` still preserves the original partial-deploy error because the initial `deployApp` call did not return its full success value.

```ts
import {
  asLeaseUuid,
  ManifestMCPError,
  ManifestMCPErrorCode,
  sanitizeForLogging,
} from '@manifest-network/manifest-sdk';
import {
  LeaseState,
  PROVISION_FAILED,
  waitForAppReady,
} from '@manifest-network/manifest-sdk/deploy';

try {
  await client.deployApp(spec);
} catch (err) {
  if (err instanceof ManifestMCPError && typeof err.details?.lease_uuid === 'string') {
    // the id came from the SDK's own error → trusted, so `as*` (not `parse*`)
    const leaseUuid = asLeaseUuid(err.details.lease_uuid);
    if (typeof err.details.recovery_outcome === 'string') {
      // Defensive if this handler is reused around orchestration: the chosen
      // recovery already completed. Salvage deliberately keeps the billing
      // lease; cancel/close already ran stopApp. Never feed either case into
      // generic cleanup or deploy again automatically.
      console.info(
        'Orchestrated deploy recovery completed; skipping cleanup:',
        err.details.recovery_outcome,
      );
    } else if (err.details.readiness_unconfirmed === true) {
      // Bound Fred path: polling ended without a failure verdict.
      if (err.code !== ManifestMCPErrorCode.OPERATION_CANCELLED) {
        // This explicit attempt can fail during chain/provider pre-flight before
        // it polls. Record the trusted UUID because those errors can omit details;
        // any failure from the new operation intentionally propagates
        // instead of `err`.
        console.info(
          'Starting explicit readiness retry for existing partial-deploy lease:',
          leaseUuid,
        );
        await waitForAppReady(client, { address, leaseUuid }, { timeoutMs: 600_000 });
      }
    } else if (err.details.failedStep === 'poll') {
      // Re-check both sources. A provider-terminal state does not make the chain inactive.
      const current = await client
        .appStatus({ address, leaseUuid })
        .catch((statusErr: unknown) => {
          console.warn(
            'Could not re-check partial deploy status; preserving the original deploy error:',
            sanitizeForLogging(
              statusErr instanceof Error ? statusErr.message : String(statusErr),
            ),
          );
          return undefined;
        });
      if (current !== undefined) {
        const chainState = current.chainState.state;
        const chainActive = chainState === LeaseState.LEASE_STATE_ACTIVE;
        const chainTerminal =
          chainState === LeaseState.LEASE_STATE_CLOSED ||
          chainState === LeaseState.LEASE_STATE_REJECTED ||
          chainState === LeaseState.LEASE_STATE_EXPIRED;
        const provisionStatus = current.fredStatus?.provision_status;
        const providerReportsFailure =
          provisionStatus !== undefined && PROVISION_FAILED.has(provisionStatus);

        if (!chainTerminal) {
          if (current.providerError !== undefined || current.fredStatus === undefined) {
            // The chain may still be ACTIVE, but provider status could not be confirmed.
            console.warn(
              'Provider status re-check was inconclusive; preserving the lease:',
              sanitizeForLogging(current.providerError ?? 'provider status was absent'),
            );
          } else if (chainActive && providerReportsFailure) {
            await client.stopApp({ leaseUuid }).catch((cleanupErr: unknown) => {
              console.warn(
                'Failed to close the confirmed failed lease; preserving the original deploy error:',
                sanitizeForLogging(
                  cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                ),
              );
            });
          } else {
            // Provider/chain mismatch or an unrecognized state: preserve and investigate.
            console.warn(
              'Lease status is not safe to clean up automatically; preserving the lease.',
            );
          }
        }
        // Only CLOSED/REJECTED/EXPIRED on chain proves no cleanup tx is needed.
      }
    } else {
      // Setup failed before polling reached a running app.
      await client.stopApp({ leaseUuid }).catch((cleanupErr: unknown) => {
        console.warn(
          'Failed to clean up the partially configured lease; preserving the original deploy error:',
          sanitizeForLogging(
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          ),
        );
      });
    }
  }
  throw err;
}
```

> **Readiness deadlines.** `pollLeaseUntilReady` defaults to `DEFAULT_POLL_TIMEOUT_MS` (10 minutes) — what the provider is actually allowed to take, including a 5-minute cold image pull. Override per call with `pollOptions.timeoutMs` (`deployApp`) or `timeoutMs` (`waitForAppReady`). Reaching the deadline throws `LeaseReadinessUnconfirmedError` (a `ProviderApiError` subclass, `reason: 'deadline' | 'provider_unreachable'`) — which means *readiness was never confirmed*, not that the deployment failed.

> **Escape hatch.** The same `deployApp` is also exported as a free `fn(ctx, spec, opts)` from `/deploy` for advanced composition. A consumer that already holds a `FredClient` can pass it directly (the client *is* a `FredAuthCtx`); a client-less consumer builds the `providerAuth` port from a bare `Signer` via `createProviderAuth(signer, { chainId })`, then assembles a `FredAuthCtx` from it plus `query`/`chain`/`fetch`/`logger`. `createProviderAuth` and the `FredAuthCtx` / `FredReadCtx` / `ProviderAuthPort` types are all re-exported from `/deploy`. Prefer the bound `client.deployApp` for everyday use.

## Restoring a closed lease

When a lease is CLOSED (e.g. credit-exhausted) but its volumes are still within the provider's retention grace window, `restoreApp` recovers them onto a **fresh** lease. It is a free function on `/deploy` — **not** a bound `client.*` method — but the `FredClient` *is* a `FredAuthCtx`, so pass the client directly as the first arg:

```ts
import { restoreApp } from '@manifest-network/manifest-sdk/deploy';
import { parseLeaseUuid } from '@manifest-network/manifest-sdk';

const { lease_uuid, status, ready, custom_domain_not_restored } = await restoreApp(
  client,                                          // the FredClient doubles as the FredAuthCtx
  { address, sourceLeaseUuid: parseLeaseUuid(closedLeaseUuid) }, // validate at the boundary
);
```

> **Branding the source id.** `parseLeaseUuid` validates at the trust boundary — use it when `closedLeaseUuid` comes from user input or an external source (a bad id fails fast with `INVALID_ARGUMENT`). If it's already a branded `LeaseUuid` from a prior SDK call (e.g. `client.getLeasesByTenant(...)`), pass it as-is with no cast; reserve the unchecked `asLeaseUuid` for values you already trust (as in the partial-success example above).

It runs as a saga — pre-flight retained-check → create a new lease → `POST /restore` → cancel-lease compensation on terminal failure — and returns the new `lease_uuid`, the `source_lease_uuid`, a `status`, the final `ready` status (when the poll converges), and any `custom_domain_not_restored` FQDNs. Whether a source is restorable (and until when) is surfaced by `appStatus` on a CLOSED lease — its result's `fredStatus` object carries `retained_until` / `items` / `restore_hint` (`restoreApp` also fails fast with `RESTORE_NOT_RETAINED` if the source isn't retained). Failures throw a `ManifestMCPError` with a `RESTORE_*` code — all non-auto-retryable, since restore is non-idempotent (`RESTORE_RETRYABLE` signals *you* may deliberately re-invoke).

**Cancelling a restore.** Pass `signal` (or a `timeout`) in the third argument. Where the cancel lands decides the outcome: **before** the create-lease broadcast it throws a plain `AbortError` with zero side effects; **after** it, the fresh lease already reserves credit, so the saga rolls it back with a compensating `cancel-lease` and throws `OPERATION_CANCELLED` carrying `details.lease_uuid` and `rolled_back: true` (falling back to `RESTORE_ORPHAN_COMPENSATION_FAILED` with `details.orphaned_lease_uuid` if that cancel fails). Once the restore POST has committed, a cancel is never compensated — the volumes are adopted, and tearing the lease down would lose them.

## Watching live status

`waitForLeaseStatus` watches the provider until the lease reaches a **terminal** state, then resolves with the final status (a converging wait — the viem `waitFor*` / cosmjs `signAndBroadcast` shape). It resolves for a *failure* terminal too; check with `isLeaseFailureTerminal`, and reject/observe as you wish. Aborting the `signal` rejects the promise.

Readiness is an **allowlist**: only a provider-reported `ready` (or a provider that reports no provision status at all) resolves as success. A status this client does not recognize — including one added by a newer provider — keeps the wait running rather than being reported as a healthy deploy, and the deadline rejection names the last status seen.

One terminal deserves a different response from the rest. A **retained** lease has been torn down with its volumes kept: the deployment is gone and the lease is closed, but the data can be recovered — onto a *fresh* lease, never this one — until `retained_until` passes.

```ts
import { isLeaseFailureTerminal, restoreApp } from '@manifest-network/manifest-sdk/deploy';

const controller = new AbortController();
const final = await client.waitForLeaseStatus(leaseUuid, {
  onStatus: (s) => console.log('progress:', s.state), // intermediate updates only
  timeout: 120_000,
  signal: controller.signal, // optional; abort rejects with signal.reason
});
if (isLeaseFailureTerminal(final)) {
  if (final.provision_status === 'retained') {
    // Recoverable until final.retained_until — restoreApp creates a NEW lease (see above).
    await restoreApp(client, { address, sourceLeaseUuid: leaseUuid });
  } else {
    throw new Error(`deploy failed: ${final.state}/${final.provision_status}`);
  }
}
```

## Catalog and SKU resolution

```ts
import { checkDeploymentReadiness } from '@manifest-network/manifest-sdk/catalog';

const catalog = await client.browseCatalog(); // bound — providers + SKUs + health, one call
const ready = await checkDeploymentReadiness(client, await client.chain.getAddress(), {
  size: 'docker-micro',
  image: 'nginx:1.25',
});
```

`browseCatalog` is a bound client method; `checkDeploymentReadiness` is a free `fn(ctx, address, input)` on `/catalog` (the client itself is a valid `ctx`). When a tier name maps to more than one provider's SKU, `resolveSku` throws `ManifestMCPErrorCode.SKU_AMBIGUOUS` with `details.candidates` — render a picker, then re-deploy pinning `skuUuid` + `providerUuid` on the spec. `client.resolveSku(...)` / `client.listSkuCandidates(...)` are bound; they're also free fns on `@manifest-network/manifest-sdk/catalog`.

## Building manifests

If you build the manifest yourself (e.g. a UI editor) rather than letting `deployApp` derive it, the builders are on `/deploy`:

```ts
import { buildManifest, buildStackManifest, mergeManifest, validateManifest } from '@manifest-network/manifest-sdk/deploy';
import type { PortConfig } from '@manifest-network/manifest-sdk/deploy';

const ingress: PortConfig = { ingress: true };
const manifest = buildManifest({ image: 'nginx:1.25', ports: { '80/tcp': ingress }, env: { FOO: 'bar' } });
```

`mergeManifest` applies UI-shaped edits onto an existing manifest while preserving fields the editor doesn't touch; `validateManifest` / `parseStackManifest` / `getServiceNames` support preview UIs. A deploy accepts at most **1 MiB** of manifest JSON. Update sends the manifest base64-encoded inside a JSON request, so its maximum raw manifest is **786,420 bytes**; both limits fit Fred's default 1 MiB inbound request cap exactly. When sending raw JSON, integer fields must use integer tokens (`3`, `1000000000`), not mathematically integral decimal/exponent spellings (`3.0`, `1e9`), because Fred decodes them into Go integer types.

## `fetch` injection, CORS, and the SSRF guard

On **Node**, prefer `createFredClientNode` from the `/node` subpath — it injects an SSRF-guarded `fetch` by default (provider URLs come from on-chain SKU records, an SSRF surface):

```ts
import { createFredClientNode } from '@manifest-network/manifest-sdk/node';

const client = await createFredClientNode({ config, walletProvider });
```

The base `createFredClient` does not guard *at connect time* by default and warns once on Node. Explicitly injecting any `fetch` opts **out** of the connect guard and its missing-guard warning; a plain `globalThis.fetch` stays unguarded, so pass it only as a deliberate opt-out. Wrap `createGuardedFetch()` from `/node` to compose. In the browser, inject a CORS-aware `fetch`; the connect-time request-blocking guard is a Node concern. (`MANIFEST_FRED_FETCH_GUARDED` is MCP-server-only — the library escape hatch is `opts.fetch`.)

Separately, provider-URL **string** SSRF classification is always on (browser included): `validateProviderUrl` default-denies a provider `apiUrl` that is a literal private/internal/loopback/metadata IP. For URLs you validate yourself — e.g. a provider **WebSocket** URL in the browser, where the native `WebSocket` has no connect-time guard (on Node, `createFredClientNode` guards the WebSocket transport too via `createNodeEventTransport`) — use the exported predicate:

```ts
import { isUrlSsrfSafe } from '@manifest-network/manifest-sdk/deploy';

if (!isUrlSsrfSafe(wsUrl)) throw new Error('unsafe provider WebSocket URL');
```

It fails open on DNS hostnames (defense-in-depth; only the Node connect guard / the browser's Private Network Access catches a hostname that resolves internally), so pair it with the connect guard on Node.

Deploying against a **local/dev provider** on `localhost`? The default-deny would reject it — pass `createFredClient({ allowLoopback: true })` (also on `createFredClientNode`), a narrow opt-in that permits loopback only, never RFC1918/metadata. Leave it off (the default) in production.

## Errors

Most failures throw `ManifestMCPError` with a `code` from `ManifestMCPErrorCode` (e.g. `INVALID_ARGUMENT`, `SKU_AMBIGUOUS`, `TX_FAILED`, `OPERATION_CANCELLED`); provider HTTP failures throw a separate `ProviderApiError` that carries `status`, `kind` and — when the provider sent one — `retryAfterMs`, not a `code` (see the guard below). Branch on `code` (or the typed guards), not message text. Before logging an error's `details`, pass it through `sanitizeForLogging` (exported from the root) to redact sensitive fields.

**What retries, and what doesn't.** Chain reads and broadcasts auto-retry transient failures (network, 5xx, 429) with exponential backoff — 3 retries, 1s base, 10s cap. **Provider HTTP calls do not**: several of them (`uploadLeaseData`, `restoreApp`, `updateApp`) are non-idempotent, so a transport-level retry could duplicate a side effect; `ProviderApiError` surfaces the provider's answer on the first failure. The one exception is the readiness poll (`pollLeaseUntilReady`, and therefore `waitForAppReady` / `deployApp`), which tolerates `PollOptions.maxConsecutiveFailures` consecutive status-read failures (default 3, reset on every successful read) and honours a `Retry-After` header before its next attempt. If you want retries around an idempotent provider read of your own, wrap it yourself — `isTransientProviderError` (`/deploy`) is the same classifier the poll uses.

For the two error shapes that carry typed detail, prefer the exported guards over `instanceof` (unreliable across duplicate package copies) or hand-rolled `code` checks:

```ts
import { isSkuAmbiguousError, ProviderApiError } from '@manifest-network/manifest-sdk';

try {
  await client.deployApp(spec);
} catch (err) {
  if (isSkuAmbiguousError(err)) {
    // err.details is narrowed to { reason: 'AMBIGUOUS_SKU_NAME', size, candidates }
    renderSkuPicker(err.details.candidates);
  } else if (ProviderApiError.isProviderApiError(err) && err.status === 409) {
    // typed provider HTTP error — dual-package-safe brand guard, exposes err.status
    handleConflict(err);
  } else {
    throw err;
  }
}
```

## Cancellation

Every typed read and transaction takes an optional trailing options bag with `signal` (an `AbortSignal`) and `timeout` (a per-call deadline in ms). Either aborts the operation; passing both composes them, and the abort reason tells you which fired — a `TimeoutError` for the deadline, your own reason for a caller cancel.

**Detect a cancellation from `signal.aborted`, never from the thrown value's type, `name`, or message.** The value a cancelled read rejects with need not be an `Error`, and over MCP it usually is not: the cancellation notification's `reason` is an optional *string*, and when an MCP client's own request timeout fires it cancels with `String(err)` — so what reaches you is the bare string `McpError: MCP error -32001: Request timed out`, with no `message` and no `stack`.

That is deliberate, and it splits by layer:

- **Reads and provider transport reject with your own abort reason, verbatim and unwrapped** — what the WHATWG DOM standard asks of an API that accepts an `AbortSignal`. Only a reason carrying *nothing at all* (`null`, or `undefined` from a foreign/polyfilled signal) is replaced with the spec's `AbortError`; an empty string is a value you chose and travels through. At the MCP tool boundary this surfaces under `code: 'UNKNOWN'`, because only a `ManifestMCPError` carries a code.
- **Transactions and orchestrated flows wrap** into `ManifestMCPError(OPERATION_CANCELLED)`. A cancellation keeps the original under `details.reason` when that path has a reason to preserve, following the convention used by Node's promise APIs. Operation-specific outcomes add their own structured fields: a compensated restore carries `details.lease_uuid` and `rolled_back`; a completed deploy recovery carries `lease_uuid` and `recovery_outcome`, with terminal recovery also reporting `stop_outcome`, `lease_state`, and an optional `transaction_hash`; readiness cancellation carries its partial-lease diagnostics. **`details.sent` is specific to the transaction seam** (`executeTx` and the on-chain tx helpers): it tells you whether a broadcast was started and therefore whether to re-query the chain before retrying. Do not require `reason`, or branch on `sent`, for every orchestration error.

Two things worth knowing about `timeout`:

- It is **one deadline for the whole operation**, not per attempt. The signal is resolved once and threaded down, so a retry ladder underneath inherits the already-elapsed budget. Size it for the worst-case ladder.
- Supplying `timeout` **together with** `signal` composes them, and the DOM spec requires a composite to keep its sources alive — the timeout signal and its armed timer stay pinned for the full duration no matter when the call finishes. A `{ signal, timeout: 600_000 }` call that returns in 50 ms still holds both for ten minutes. A lone `timeout` is not composed and is reclaimed normally.

A malformed `timeout` (non-integer, `0` or negative, or above the 32-bit `2147483647` ms ceiling) throws `INVALID_CONFIG` before anything is dispatched — it consumes no rate-limit token and sends no transaction. The ceiling is not cosmetic: a larger delay does not fail, it silently becomes a **1 ms** deadline.

```ts
const controller = new AbortController();
const stop = () => controller.abort('user navigated away'); // any value; a string is fine

try {
  await client.getLease(leaseUuid, { signal: controller.signal, timeout: 30_000 });
} catch (err) {
  if (controller.signal.aborted) return; // ← the check that always works
  throw err;
}
```

Cancelling also aborts the SDK's own rate-limit wait, so a cancelled call gives its token back to the budget instead of holding one it will never use. The chain RPC underneath still cannot be cancelled — manifestjs accepts no `AbortSignal` — so an abandoned read runs to completion server-side; you simply stop awaiting it.

## Orchestration tier (optional)

The universal `@manifest-network/manifest-sdk/orchestration` subpath adds four plan → confirm → recover flows on top of the capability tier (`deployApp`, `manageDomain`, `closeLease`, `troubleshootDeployment`), plus `loadChainDenomMap`, a loader/helper that preloads chain-data for denom humanization. The four orchestrators are **callback-driven** — `fn(input, callbacks, opts)` with `onPlan` / `onConfirm` / `onProgress` — a different shape from the capability tier's `fn(ctx, input)`, so the host can drive a human-in-the-loop UI. Browser code can import the subpath; only `deployApp(spec, callbacks, { dataDir })` (manifest persistence via filesystem/crypto/path) and `loadChainDenomMap(path)` (filesystem-backed chain data) require Node when invoked. Omit those Node-only options in browser flows.

For orchestrated deploy recovery, an accepted `retry_set_domain` returns the normal `DeployResult`. Completed `salvage_without_domain`, `cancel_lease`, and `close_lease` choices end that invocation with non-retryable `OPERATION_CANCELLED`: `details.recovery_outcome` identifies the selected choice and `details.lease_uuid` identifies the existing lease. Terminal choices additionally expose `details.stop_outcome` and `details.lease_state`, plus `details.transaction_hash` when `stopApp` returns one; a post-broadcast terminal reconciliation can omit the hash. Salvage intentionally retains the live, billing lease, so callers must not treat this error as a failed transaction or blindly redeploy.

The orchestration `deployApp` has one additional `DEPLOY_READINESS_UNCONFIRMED` shape: readiness returned, but the canonical final provider state was absent, malformed, or non-ACTIVE. It is positively identified by `details.readiness_reason === 'final_state_mismatch'`; `details.state_source` and bounded `details.observed_state` carry the diagnostic. Apply the wait-and-recheck branch above only to poll-side uncertainty (`failedStep === 'poll'` or `poll_reason`). For final-state disagreement, inspect status and diagnostics, preserve the existing lease, and report a persistent provider/client mismatch instead of automatically waiting or redeploying.

## Low-level escape hatch

For raw chain access beyond the typed surface, the root re-exports `CosmosClientManager` (the keyed connection manager) — though for raw on-chain message broadcasting, prefer `executeTx`, which is typed and handles atomicity/serialization.

When you need the generic tier-2 query/tx primitives themselves, the `@manifest-network/manifest-sdk/chain` subpath re-exports `cosmosQuery` and `cosmosTx` (from **core**) — the raw `(module, subcommand, args)` primitives behind the `cosmos_query` / `cosmos_tx` tools, for when a read or message isn't covered by the branded `/reads` + `/deploy` surface:

```ts
import { cosmosQuery, cosmosTx } from '@manifest-network/manifest-sdk/chain';
```

> The stringly, JSON-shaped `cosmos_query` / `cosmos_tx` **tools** are the MCP-server face in the separate `@manifest-network/manifest-mcp-{chain,lease,fred}` packages, for LLM/agent hosts; the `/chain` subpath above exposes their typed primitives directly, not that JSON tool wrapper.

### Raw manifestjs queries — `client.query`

You do **not** need a second manifestjs LCD/RPC client for reads the SDK doesn't wrap. The read client already exposes manifestjs's own **typed** query tree at `client.query` — one client, two layers:

```ts
const client = await createManifestReadClient({ config: { chainId, restUrl } });

// Typed SDK read — branded, rate-limited, not-found-aware:
const lease = await client.getLease(leaseUuid);          // BrandedLease | null

// Raw manifestjs passthrough for a 1:1 read with no typed wrapper:
const { creditAddress } = await client.query.liftedinit.billing.v1.creditAddress({ tenant });
const { balance } = await client.query.cosmos.bank.v1beta1.balance({ address, denom: 'umfx' });
```

- **Already decoded.** `client.query` responses are typed objects with **numeric** enum fields (a lease's `state` is `2`, not the LCD string `"LEASE_STATE_ACTIVE"`) — no hand-rolled `lcdConvert` / enum-fixup needed. This is transport-agnostic: over REST the adapter runs `snakeToCamelDeep` + protobuf `fromJSON`; over RPC the Telescope client returns already-decoded objects. Either way the shape is the same.
- **`client.query` bypasses the rate limiter.** Only the typed reads (`getLease`, `getBalance`, …) acquire a token from the client's token bucket. Prefer a typed read where one exists; reach for `client.query` for the 1:1 passthroughs (`creditAccount`, `creditAddress`, single-denom `bank.balance`, …) that have no branded wrapper — wrapping those would just re-implement manifestjs.
- **Unsupported over REST.** `cosmos.orm.query.v1alpha1` and `liftedinit.manifest.v1` throw `UNSUPPORTED_QUERY` on property access (no LCD support / no query service). Neither has an app-facing read; everything else routes.

## Faucet

Funding a brand-new wallet's gas is a testnet/operator concern, so the faucet ops live on the dedicated `@manifest-network/manifest-sdk/faucet` subpath — deliberately **off the root barrel**, so a production app never picks them up by accident. It's browser-safe and carries `requestFaucet`, `requestFaucetCredit`, and `fetchFaucetStatus` (plus the `FaucetAccount` / `FaucetDripResult` / `FaucetStatusResponse` / `RequestFaucetResult` types) for an in-app top-up affordance:

```ts
import { requestFaucet, fetchFaucetStatus } from '@manifest-network/manifest-sdk/faucet';
```

## Browser quirks

- Don't import `@manifest-network/manifest-sdk/node` or `…/manifest-mcp-node` in a browser bundle — the SDK `/node` subpath is mapped so a browser bundler fails fast rather than pulling Node builtins. `/orchestration` can be bundled, but `deployApp(spec, callbacks, { dataDir })` and `loadChainDenomMap(path)` remain Node-only at call time.
- Many chain fields (heights, gas, supply) round-trip as `bigint`, which `JSON.stringify` rejects — supply a small replacer that coerces `bigint` to a string when serializing chain responses.
- The browser blocks cross-origin `fetch` by default — run a CORS proxy in dev or push provider calls server-side, and pass your CORS-aware `fetch` to the client so URL validation stays intact.

## Stable vs internal exports

The SDK barrel and its documented subpaths are the public, semver-versioned surface. Don't reach into `dist/` deep paths or the underlying `manifest-mcp-*` packages' internals — if something you need isn't re-exported, [open an issue](https://github.com/manifest-network/manifest-mcp-mono/issues).
