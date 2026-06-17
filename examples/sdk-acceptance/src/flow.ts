import type {
  ManifestMCPConfig,
  WalletProvider,
} from '@manifest-network/manifest-sdk';

/**
 * STUB (Task B1) — the real 8-step compose-only lifecycle lands in Task B2.
 *
 * This file exists so the package barrel (`src/index.ts`) resolves and the example builds green
 * before the flow is implemented. The signature is the authoritative B2 shape; do not widen it.
 */
export interface AcceptanceOpts {
  config: ManifestMCPConfig;
  walletProvider: WalletProvider;
  /** Injected fetch (cert-trusting undici in e2e; globalThis.fetch in browser). */
  fetch: typeof globalThis.fetch;
  variant: 'single' | 'stack';
}

export async function runAcceptanceFlow(_opts: AcceptanceOpts): Promise<void> {
  throw new Error('runAcceptanceFlow is not implemented yet (Task B2)');
}
