import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';
import { beforeAll, describe, it } from 'vitest';
import {
  createFredClient,
  type ManifestMCPConfig,
  MnemonicWalletProvider,
  parseFqdn,
} from '@manifest-network/manifest-sdk';
import { runAcceptanceFlow } from '@manifest-network/sdk-acceptance';

/**
 * SDK-direct acceptance — the single tracked P0a metric (ENG-309 / spec §9).
 *
 * Proves the SDK is real by driving the compose-only `runAcceptanceFlow` (which imports ONLY
 * `@manifest-network/manifest-sdk` + `manifestjs`) end-to-end against the live docker-compose devnet,
 * for BOTH a single-service and a stack-format lease.
 *
 * TWO HARD SEPARATIONS this file enforces:
 *  1. The example app (examples/sdk-acceptance/src) is browser-clean + compose-only. The node-only
 *     machinery — the cert-trusting undici fetch, the genesis-funded MnemonicWalletProvider, the
 *     docker harness — lives ONLY here. `undici`/`node:fs` are imported in THIS file and nowhere in
 *     the example. The flow takes `fetch`/`walletProvider`/`config` as INJECTED params.
 *  2. Faucet (umfx, gas) is NOT billing credit. The flow resolves the credit denom from
 *     getSKUs().basePrice.denom and funds with THAT — asserted by the B2 unit test; here we just run it.
 *
 * The genesis-funded tenant (MNEMO2 in e2e/.env, mirrored in e2e/helpers/mcp-client.ts) signs txs.
 */

// The genesis-funded tenant mnemonic — verbatim from e2e/helpers/mcp-client.ts:6 (MNEMO2 in e2e/.env).
const DEFAULT_MNEMONIC =
  'wealth flavor believe regret funny network recall kiss grape useless pepper cram hint member few certain unveil rather brick bargain curious require crowd raise';

const config: ManifestMCPConfig = {
  chainId: 'manifest-localnet',
  rpcUrl: 'http://localhost:26657',
  gasPrice: '0.01umfx',
  addressPrefix: 'manifest',
};

// providerd is HTTPS self-signed on loopback → trust its cert via an undici Agent, wrapped as fetch and
// INJECTED into the SDK (createFredClient({ fetch })). In-process, no NODE_EXTRA_CA_CERTS race; node-only,
// confined to THIS test (kept out of the browser-built example). E2E_TLS_CERT_PATH is set by global-setup.
function certTrustingFetch(): typeof globalThis.fetch {
  const ca = readFileSync(process.env.E2E_TLS_CERT_PATH as string, 'utf8');
  const dispatcher = new Agent({ connect: { ca } });
  return ((
    input: Parameters<typeof globalThis.fetch>[0],
    init: Parameters<typeof globalThis.fetch>[1],
  ) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as typeof globalThis.fetch;
}

/**
 * Custom-domain (MsgSetItemCustomDomain / Query.LeaseByCustomDomain) landed in manifest-ledger v2.1.0 /
 * manifestjs 2.4.1. Older devnet images reject the type URL / query path. Probe once and skip step 4 of
 * the flow when unsupported (B3 MF-6 probe-skip — more robust than pinning the image). Mirrors the
 * feature-detect in billing-custom-domain.e2e.test.ts but via the SDK client, not the MCP transport.
 */
async function probeCustomDomainSupported(
  fetch: typeof globalThis.fetch,
): Promise<boolean> {
  const walletProvider = new MnemonicWalletProvider(config, DEFAULT_MNEMONIC);
  await walletProvider.connect();
  const client = await createFredClient({ config, walletProvider, fetch });
  try {
    // An unclaimed sentinel FQDN: a v2.1+ chain answers with a structured NotFound ("no lease with
    // custom_domain X") → the path is registered → feature present. Pre-v2.1 chains return
    // "unknown query path" / "unable to resolve type URL" → feature genuinely absent.
    await client.getLeaseByCustomDomain(parseFqdn('probe-unclaimed.e2e.test'));
    return true; // a claimed sentinel (unlikely) still proves the path is registered
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unknown query path|unable to resolve type URL/i.test(message)) {
      console.warn(
        '[sdk-acceptance] chain does not expose v2.1 custom-domain queries — ' +
          'skipping step 4 (setItemCustomDomain). Bump manifest-ledger to v2.1.0+ to exercise it.',
      );
      return false;
    }
    // NotFound / no lease with custom_domain / key not found → the feature IS registered.
    return true;
  } finally {
    client.dispose();
    await walletProvider.disconnect();
  }
}

describe('SDK acceptance (compose-only, live chain)', () => {
  let skipCustomDomain = false;

  beforeAll(async () => {
    skipCustomDomain = !(await probeCustomDomainSupported(certTrustingFetch()));
  });

  const run = async (variant: 'single' | 'stack') => {
    const walletProvider = new MnemonicWalletProvider(config, DEFAULT_MNEMONIC);
    await walletProvider.connect();
    try {
      await runAcceptanceFlow({
        config,
        walletProvider,
        fetch: certTrustingFetch(),
        variant,
        skipCustomDomain,
      });
    } finally {
      await walletProvider.disconnect(); // clears the mnemonic; matches probeCustomDomainSupported
    }
  };

  it('single-service: deploy → … → stopApp', () => run('single'), 300_000);
  it('stack-format lease: deploy → … → stopApp', () => run('stack'), 300_000);
});
