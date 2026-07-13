import type { CapabilityCtx } from '@manifest-network/manifest-mcp-core';
import type { ProviderAuthPort } from './http/provider-auth.js';

/**
 * Non-auth Fred reads: chain reads (`query`/`chain`) + provider HTTP (`fetch`), no signer.
 * A structural superset of the values a converted read fn needs.
 *
 * `allowLoopback` carries the fred server's SSRF switch down to the provider-URL
 * string check: when the connect-guard is disabled (MANIFEST_FRED_FETCH_GUARDED=0)
 * the server sets it `true` so loopback provider URLs are permitted (dev/e2e),
 * keeping both SSRF layers on one switch. Default (unset) is strict — library and
 * browser consumers never relax loopback (ENG-490).
 */
export type FredReadCtx = Pick<
  CapabilityCtx,
  'query' | 'chain' | 'fetch' | 'logger'
> & { readonly allowLoopback?: boolean };

/**
 * Provider-authenticated Fred fns: a read ctx + the signer-backed token provider.
 * `signer` stays encapsulated inside `providerAuth` (built once at the composition root).
 */
export type FredAuthCtx = FredReadCtx & { providerAuth: ProviderAuthPort };
