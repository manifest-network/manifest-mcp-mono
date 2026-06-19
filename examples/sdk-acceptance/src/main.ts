import type { AcceptanceOpts } from './flow.js';
import { runAcceptanceFlow } from './flow.js';

/**
 * Browser-build entry (Task B4). NEVER run in CI — it exists solely so the rolldown
 * `platform:browser` build pulls the WHOLE flow graph (createFredClient → the SDK reads/txs →
 * fred's provider HTTP → the manifestjs codec). That is what makes the browser build MEANINGFUL:
 * a green build proves the entire compose-only acceptance flow is browser-safe (no UNGUARDED
 * node-only modules), not just a trivial import.
 *
 * The browser host supplies `config`, `walletProvider`, and `fetch` (here `globalThis.fetch`) — the
 * same INJECTED-DI contract the e2e node harness uses with a cert-trusting undici fetch + a funded
 * wallet. Nothing here is node-only.
 */
export async function main(
  opts: Pick<AcceptanceOpts, 'config' | 'walletProvider' | 'variant'>,
): Promise<void> {
  await runAcceptanceFlow({
    config: opts.config,
    walletProvider: opts.walletProvider,
    fetch: globalThis.fetch,
    variant: opts.variant,
  });
}
