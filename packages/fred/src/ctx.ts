import type { CapabilityCtx } from '@manifest-network/manifest-mcp-core';
import type { ProviderAuthPort } from './http/provider-auth.js';

/**
 * Non-auth Fred reads: chain reads (`query`/`chain`) + provider HTTP (`fetch`), no signer.
 * A structural superset of the values a converted read fn needs.
 */
export type FredReadCtx = Pick<
  CapabilityCtx,
  'query' | 'chain' | 'fetch' | 'logger'
>;

/**
 * Provider-authenticated Fred fns: a read ctx + the signer-backed token provider.
 * `signer` stays encapsulated inside `providerAuth` (built once at the composition root).
 */
export type FredAuthCtx = FredReadCtx & { providerAuth: ProviderAuthPort };
