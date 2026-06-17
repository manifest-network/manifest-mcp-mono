import {
  asLeaseUuid,
  createFredClient,
  type FredClient,
  type ManifestMCPConfig,
  parseFqdn,
  type WalletProvider,
} from '@manifest-network/manifest-sdk';
import {
  buildManifest,
  buildStackManifest,
  createAuthTokens,
  deployApp,
  type EncodeObject,
  type FredLeaseStatus,
  getAppLogs,
  getLeaseConnectionInfo,
  LeaseState,
  PROVISION_FAILED,
  restartApp,
  updateApp,
} from '@manifest-network/manifest-sdk/deploy';
import { MsgFundCredit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/tx.js'; // sanctioned

/**
 * Drift-proof deploy-spec type: derived from `deployApp`'s 4th positional param so the example never
 * needs `AppDeploySpec` re-exported (and never resorts to `as never`). The inner `as {…}` narrowings on
 * `spec.services`/`spec.image` below are the variant projections (single vs stack), not type escapes.
 */
type DeploySpec = Parameters<typeof deployApp>[3];

export interface AcceptanceOpts {
  config: ManifestMCPConfig;
  walletProvider: WalletProvider;
  /** Injected fetch (cert-trusting undici in e2e; globalThis.fetch in browser). */
  fetch: typeof globalThis.fetch;
  variant: 'single' | 'stack';
  /**
   * Skip step 4 (setItemCustomDomain) when the chain image is too old to support the
   * custom-domain feature (manifest-ledger v2.1.0+ / manifestjs 2.4.1+). The e2e node harness
   * feature-detects support against the live chain and sets this (B3 MF-6 probe-skip). Defaults to
   * running the step — so the browser build + the mocked unit test exercise the full 8-step graph.
   */
  skipCustomDomain?: boolean;
}

// onComplete fires for FAILURE terminals too — the flow MUST reject on these (else a failed deploy
// false-greens the metric). PROVISION_FAILED (a Set) covers the ACTIVE-but-provision-failed case.
const FAILURE_TERMINALS = [
  LeaseState.LEASE_STATE_CLOSED,
  LeaseState.LEASE_STATE_REJECTED,
  LeaseState.LEASE_STATE_EXPIRED,
];

/**
 * The compose-only acceptance flow: deploy → … → stopApp, composed from ONLY the public SDK
 * (`@manifest-network/manifest-sdk` + its `/deploy` subpath) and the sanctioned manifestjs codec.
 * Browser-buildable — `fetch`/`walletProvider`/`config` are INJECTED (the cert-trusting undici fetch +
 * the funded wallet + docker live in the `e2e/` node harness, never here). The credit denom is resolved
 * at runtime from `getSKUs()` (NOT the gas/`umfx` faucet denom).
 */
export async function runAcceptanceFlow(opts: AcceptanceOpts): Promise<void> {
  const client: FredClient = await createFredClient({
    config: opts.config,
    walletProvider: opts.walletProvider,
    fetch: opts.fetch,
  });
  try {
    const addr = await client.chain.getAddress();
    const tokens = createAuthTokens(client.signer, {
      chainId: client.chain.getConfig().chainId,
    });
    // §2c bridge: address-closing + arity-adapting the address-bound thunks for the positional fred fns.
    const getAuthToken = (_a: string, uuid: string) =>
      tokens.getAuthToken(asLeaseUuid(uuid));
    const getLeaseDataAuthToken = (_a: string, uuid: string, mh: string) =>
      tokens.getLeaseDataAuthToken(asLeaseUuid(uuid), mh);

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
    const deployed = await deployApp(
      client.chain,
      getAuthToken,
      getLeaseDataAuthToken,
      spec,
      {},
      client.fetch,
    );
    const leaseUuid = deployed.lease_uuid;
    const serviceName = opts.variant === 'stack' ? 'web' : undefined;

    // 2) query (bound)
    await client.getLeasesByTenant({
      tenant: addr,
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
    });
    const lease = await client.getLease(leaseUuid);
    if (!lease) throw new Error(`lease ${leaseUuid} not found after deploy`);

    // 3) getLeaseConnectionInfo (positional; reuse deployed.provider_url)
    await getLeaseConnectionInfo(
      deployed.provider_url,
      leaseUuid,
      await tokens.getAuthToken(asLeaseUuid(leaseUuid)),
      client.fetch,
    );

    // 4) setItemCustomDomain (bound; serviceName required for the stack item) — feature-gated (B3 MF-6:
    // the e2e harness probes the chain and sets opts.skipCustomDomain when the image predates v2.1.0).
    if (!opts.skipCustomDomain) {
      await client.setItemCustomDomain({
        leaseUuid: asLeaseUuid(leaseUuid),
        customDomain: parseFqdn('app.example.com'),
        serviceName,
      });
    }

    // 5) restart / update / getLogs (positional; poll-on-409). The update manifest is variant-shaped:
    await retryOn409(() =>
      restartApp(client.query, addr, leaseUuid, getAuthToken, client.fetch),
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
                    ports: Record<string, Record<string, never>>;
                  }
                >;
              }
            ).services,
          })
        : buildManifest({
            image: (spec as { image: string }).image,
            ports: { '8080/tcp': {} },
          });
    await retryOn409(() =>
      updateApp(
        client.query,
        addr,
        leaseUuid,
        getAuthToken,
        JSON.stringify(updateManifest),
        undefined,
        client.fetch,
      ),
    );
    await getAppLogs(
      client.query,
      addr,
      leaseUuid,
      getAuthToken,
      100,
      client.fetch,
    );

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

    // 7) subscribeLeaseStatus (poll) — resolve on SUCCESS terminal, REJECT on FAILURE terminal.
    await new Promise<FredLeaseStatus>((resolve, reject) => {
      const stop = client.subscribeLeaseStatus(asLeaseUuid(leaseUuid), {
        onData: () => {},
        onComplete: (final) => {
          const failed =
            FAILURE_TERMINALS.includes(final.state) ||
            (final.provision_status !== undefined &&
              PROVISION_FAILED.has(final.provision_status));
          if (failed)
            reject(
              new Error(
                `lease reached a FAILURE terminal: ${final.state}/${final.provision_status}`,
              ),
            );
          else resolve(final);
        },
        onError: (e) => {
          stop();
          reject(e);
        },
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
async function retryOn409(
  fn: () => Promise<unknown>,
  tries = 10,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      const status = (e as { status?: number }).status; // ProviderApiError carries .status
      if (status !== 409 || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
