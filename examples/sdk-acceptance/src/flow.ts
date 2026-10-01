import {
  createFredClient,
  type FredClient,
  type FredCompatibility,
  type ManifestMCPConfig,
  parseFqdn,
  type WalletProvider,
} from '@manifest-network/manifest-sdk';
import {
  buildManifest,
  buildStackManifest,
  createMaintenanceIdempotencyKey,
  deployApp,
  type EncodeObject,
  getAppLogs,
  getLeaseConnectionInfo,
  getLeaseReleases,
  getLeaseStatus,
  isLeaseFailureTerminal,
  LeaseState,
  restartApp,
  updateApp,
} from '@manifest-network/manifest-sdk/deploy';
import { MsgFundCredit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js'; // sanctioned
import {
  submitDevnetMaintenance,
  submitLegacyDevnetMaintenance,
} from './maintenance-admission.js';

/**
 * Drift-proof deploy-spec type: derived from `deployApp`'s spec param (2nd positional, after the
 * `FredAuthCtx`) so the example stays pinned to the fn's real input even if it drifts (and never
 * resorts to `as never`). `AppDeploySpec` is now re-exported from `/deploy` for other consumers;
 * the example keeps this derivation deliberately. The inner `as {…}` narrowings on
 * `spec.services`/`spec.image` below are the variant projections (single vs stack), not type escapes.
 */
type DeploySpec = Parameters<typeof deployApp>[1];

export interface AcceptanceOpts {
  config: ManifestMCPConfig;
  walletProvider: WalletProvider;
  /** Injected fetch (cert-trusting undici in e2e; globalThis.fetch in browser). */
  fetch: typeof globalThis.fetch;
  variant: 'single' | 'stack';
  /** Explicit provider contract; defaults to the SDK's v0.13 compatibility. */
  fredCompatibility?: FredCompatibility;
  /**
   * Skip step 4 (setItemCustomDomain) when the chain image is too old to support the
   * custom-domain feature (manifest-ledger v2.1.0+ / manifestjs 2.4.1+). The e2e node harness
   * feature-detects support against the live chain and sets this (B3 MF-6 probe-skip). Defaults to
   * running the step — so the browser build + the mocked unit test exercise the full 8-step graph.
   */
  skipCustomDomain?: boolean;
}

/**
 * The compose-only acceptance flow: deploy → … → stopApp, composed from ONLY the public SDK
 * (`@manifest-network/manifest-sdk` + its `/deploy` subpath) and the sanctioned manifestjs codec.
 * Browser-buildable — `fetch`/`walletProvider`/`config` are INJECTED (the cert-trusting undici fetch +
 * the funded wallet + docker live in the `e2e/` node harness, never here). The credit denom is resolved
 * at runtime from `getSKUs()` (NOT the gas/`umfx` faucet denom).
 *
 * NOTE: this flow deliberately MIXES the bound-client methods (the canonical everyday
 * surface) with the free ctx-shaped `/deploy` fns called with the CLIENT AS THE CTX
 * (a FredClient structurally IS a FredAuthCtx) — a coverage flow exercising both, not a
 * recommended style. A client-LESS consumer would instead build the `providerAuth` port via
 * `createProviderAuth(signer, { chainId })` (re-exported from `/deploy`) and slot it into a
 * `FredAuthCtx` alongside `query`/`chain`/`fetch`/`logger`.
 */
export async function runAcceptanceFlow(opts: AcceptanceOpts): Promise<void> {
  const fredCompatibility = opts.fredCompatibility ?? 'v0.13';
  const client: FredClient = await createFredClient({
    config: opts.config,
    walletProvider: opts.walletProvider,
    fetch: opts.fetch,
    fredCompatibility,
    // The compose devnet's providerd registers a loopback apiUrl (https://localhost:8080),
    // so this dev/e2e flow opts into the narrow loopback SSRF allowance (never RFC1918/metadata).
    allowLoopback: true,
  });
  try {
    const addr = await client.chain.getAddress();

    // 0) BILLING CREDIT — resolve the SKU price denom (NOT gas/umfx) and self-fund.
    const skus = await client.getSKUs({});
    const micro = skus.find((s) => s.name === 'docker-micro');
    if (!micro) throw new Error('docker-micro SKU not found on chain');
    const creditDenom = micro.basePrice.denom; // factory/${POA_ADMIN}/upwr — billing, NOT gas
    await client.fundCredits({ amount: `5000000${creditDenom}` });

    // 1) deploy
    const spec: DeploySpec = (
      opts.variant === 'stack'
        ? {
            services: {
              web: {
                image: 'nginxinc/nginx-unprivileged:alpine',
                ports: { '8080/tcp': {} },
              },
            },
            size: 'docker-micro',
          }
        : {
            image: 'nginxinc/nginx-unprivileged:alpine',
            port: 8080,
            size: 'docker-micro',
          }
    ) as DeploySpec;
    // Bound the readiness poll inside the e2e per-test timeout (300s). fred's
    // default is the provider's own 10-minute provisioning ceiling, which is
    // right for production but would let a stalled devnet blow the vitest
    // timeout — an opaque kill instead of a diagnosable error. The deploy,
    // restart, update, and final status polls total at most 240s. Admission
    // recovery adds at most 20s of backoff, leaving 40s for other API and chain
    // calls. Also exercises
    // the pollOptions pass-through the SDK publishes (ENG-661).
    const deployed = await deployApp(client, spec, {
      pollOptions: { timeoutMs: 120_000 },
    });
    const leaseUuid = deployed.lease_uuid;
    const serviceName = opts.variant === 'stack' ? 'web' : undefined;

    // 2) query (bound)
    await client.getLeasesByTenant({
      tenant: addr,
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
    });
    const lease = await client.getLease(leaseUuid);
    if (!lease) throw new Error(`lease ${leaseUuid} not found after deploy`);

    // 3) getLeaseConnectionInfo (positional; reuse deployed.provider_url). This calls the low-level
    // provider fn directly (bypassing the client ctx), so thread the client's own allowLoopback for
    // the loopback devnet provider — a consumer using the low-level fns must pass it explicitly.
    await getLeaseConnectionInfo(
      deployed.provider_url,
      leaseUuid,
      await client.providerAuth.providerToken({ address: addr, leaseUuid }),
      client.fetch,
      client.allowLoopback,
    );

    // 4) setItemCustomDomain (bound; serviceName required for the stack item) — feature-gated (B3 MF-6:
    // the e2e harness probes the chain and sets opts.skipCustomDomain when the image predates v2.1.0).
    if (!opts.skipCustomDomain) {
      await client.setItemCustomDomain({
        leaseUuid,
        customDomain: parseFqdn('app.example.com'),
        serviceName,
      });
    }

    // 5) Wait for each command. The local harness retries only the pinned
    // provider's exact admission answers: a pending 503 with its original key,
    // or a definitive 409 fence after checking status and history.
    const readReleases = async () =>
      getLeaseReleases(
        deployed.provider_url,
        leaseUuid,
        await client.providerAuth.providerToken({ address: addr, leaseUuid }),
        client.fetch,
        client.allowLoopback,
      );
    const reconcile =
      (before: Awaited<ReturnType<typeof readReleases>>) => async () => {
        const status = await getLeaseStatus(
          deployed.provider_url,
          leaseUuid,
          await client.providerAuth.providerToken({ address: addr, leaseUuid }),
          client.fetch,
          undefined,
          client.allowLoopback,
        );
        return (
          status.provision_status === 'ready' &&
          JSON.stringify(await readReleases()) === JSON.stringify(before)
        );
      };
    const beforeRestart = await readReleases();
    const submit = <T>(
      operation: 'restart' | 'update',
      before: Awaited<ReturnType<typeof readReleases>>,
      command: (key?: string) => Promise<T>,
    ) =>
      fredCompatibility === 'pr240'
        ? submitDevnetMaintenance({
            operation,
            createKey: createMaintenanceIdempotencyKey,
            submit: command,
            reconcile: reconcile(before),
          })
        : submitLegacyDevnetMaintenance({
            operation,
            submit: command,
            reconcile: reconcile(before),
          });
    await submit('restart', beforeRestart, (idempotencyKey) =>
      restartApp(
        client,
        { address: addr, leaseUuid },
        {
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          pollOptions: { timeoutMs: 45_000 },
        },
      ),
    );
    const updateManifest =
      opts.variant === 'stack'
        ? buildStackManifest({
            services: (
              spec as {
                services: Record<
                  string,
                  {
                    image: string;
                    ports: Record<
                      string,
                      { host_port?: number; ingress?: boolean }
                    >;
                  }
                >;
              }
            ).services,
          })
        : buildManifest({
            image: (spec as { image: string }).image,
            ports: { '8080/tcp': {} },
          });
    const beforeUpdate = await readReleases();
    await submit('update', beforeUpdate, (idempotencyKey) =>
      updateApp(
        client,
        {
          address: addr,
          leaseUuid,
          manifest: JSON.stringify(updateManifest),
        },
        {
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          pollOptions: { timeoutMs: 45_000 },
        },
      ),
    );
    await getAppLogs(client, { address: addr, leaseUuid, tail: 100 });

    // 6) executeTx BATCH — two MsgFundCredit (atomic double-fund); caller sets sender/tenant.
    const fundMsg = (): EncodeObject => ({
      typeUrl: '/liftedinit.billing.v1.MsgFundCredit',
      value: MsgFundCredit.fromPartial({
        sender: addr,
        tenant: addr,
        amount: { denom: creditDenom, amount: '1' },
      }),
    });
    await client.executeTx([fundMsg(), fundMsg()]);

    // 7) waitForLeaseStatus — resolve at any terminal; a FAILURE terminal must reject the flow
    // (else a failed deploy false-greens the metric).
    const finalStatus = await client.waitForLeaseStatus(leaseUuid, {
      timeout: 30_000,
    });
    if (isLeaseFailureTerminal(finalStatus)) {
      throw new Error(
        `lease reached a FAILURE terminal: ${finalStatus.state}/${finalStatus.provision_status}`,
      );
    }

    // 8) stopApp (bound)
    await client.stopApp({ leaseUuid });
  } finally {
    client.dispose();
  }
}
