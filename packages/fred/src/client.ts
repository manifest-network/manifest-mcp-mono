import {
  type BoundFn,
  createManifestClient,
  type FullClientOptions,
  type LeaseUuid,
  logger,
  type ManifestClient,
} from '@manifest-network/manifest-mcp-core';
import {
  createProviderAuth,
  type ProviderAuthPort,
} from './http/provider-auth.js';
import { appStatus } from './tools/appStatus.js';
import { browseCatalog } from './tools/browseCatalog.js';
import { deployApp } from './tools/deployApp.js';
import { getLeaseConnectionInfo } from './tools/getLeaseConnectionInfo.js';
import { getAppLogs } from './tools/getLogs.js';
import { restartApp } from './tools/restartApp.js';
import {
  type SubscribeLeaseStatusOptions,
  subscribeLeaseStatus,
} from './tools/subscribeLeaseStatus.js';
import { updateApp } from './tools/updateApp.js';
import { waitForAppReady } from './tools/waitForAppReady.js';

/** Provider-backed methods layered onto a core ManifestClient by createFredClient. */
export interface FredActions {
  subscribeLeaseStatus(
    leaseUuid: LeaseUuid,
    opts: SubscribeLeaseStatusOptions,
  ): () => void;
  browseCatalog: BoundFn<typeof browseCatalog>;
  appStatus: BoundFn<typeof appStatus>;
  getAppLogs: BoundFn<typeof getAppLogs>;
  restartApp: BoundFn<typeof restartApp>;
  updateApp: BoundFn<typeof updateApp>;
  waitForAppReady: BoundFn<typeof waitForAppReady>;
  getLeaseConnectionInfo: BoundFn<typeof getLeaseConnectionInfo>;
  deployApp: BoundFn<typeof deployApp>;
}

/**
 * A full Manifest client + the Fred provider methods. Carries `providerAuth` so the client object
 * structurally satisfies `FredAuthCtx` — it IS the ctx the bound provider methods close over.
 */
export type FredClient = ManifestClient & {
  providerAuth: ProviderAuthPort;
} & FredActions;

/** The fred-action decorator: thin .bind(ctx) closures over the free fns (viem-style; ctx = the client). */
export function fredActions(ctx: FredClient): FredActions {
  return {
    subscribeLeaseStatus: (leaseUuid, opts) =>
      subscribeLeaseStatus(ctx, leaseUuid, opts),
    browseCatalog: (...a) => browseCatalog(ctx, ...a),
    appStatus: (...a) => appStatus(ctx, ...a),
    getAppLogs: (...a) => getAppLogs(ctx, ...a),
    restartApp: (...a) => restartApp(ctx, ...a),
    updateApp: (...a) => updateApp(ctx, ...a),
    waitForAppReady: (...a) => waitForAppReady(ctx, ...a),
    getLeaseConnectionInfo: (...a) => getLeaseConnectionInfo(ctx, ...a),
    deployApp: (...a) => deployApp(ctx, ...a),
  };
}

/**
 * Pure predicate: should `createFredClient` warn that provider HTTP is unguarded? True only on
 * Node (`isNode`) when the caller injected no `fetch`. `isNode` is a parameter so the browser-negative
 * case is unit-testable. Not part of the public SDK surface (not re-exported from the fred barrel).
 */
export function shouldWarnUnguarded(
  hasInjectedFetch: boolean,
  isNode: boolean,
): boolean {
  return !hasInjectedFetch && isNode;
}

const UNGUARDED_FETCH_WARNING =
  'createFredClient: provider HTTP is running through an unguarded fetch on Node. ' +
  'Provider URLs come from on-chain SKU records, so this is an SSRF surface. ' +
  "Use createFredClientNode from '@manifest-network/manifest-mcp-fred/node' " +
  "(re-exported by the SDK as '@manifest-network/manifest-sdk/node'; SSRF-safe by default), " +
  "or inject an SSRF-guarded fetch via createGuardedFetch from '@manifest-network/manifest-mcp-core/guarded-fetch'. " +
  'Note: injecting your own fetch opts OUT of the SSRF guard.';

// Module-level once-latch: warn at most once per process (isolated in tests via vi.resetModules()).
let warnedUnguarded = false;

/**
 * Create a full app client: core's chain-backed ManifestClient plus the Fred provider methods. The
 * fully-decorated factory lives in fred (not core) because the provider methods hit the Fred backend,
 * not the chain ctx wraps (viem one-client-one-backend rule, #2535). Requires a walletProvider.
 *
 * The signer-backed `providerAuth` token provider is built once here (the composition root) over
 * `client.signer`, and attached to the client object so it satisfies `FredAuthCtx` before
 * `fredActions` binds the lifecycle methods onto it.
 *
 * @remarks
 * Wraps {@link createManifestClient}, so the same shared-config-key caveat applies: each client acquires
 * one reference on a `CosmosClientManager` instance keyed by config (`chainId:rpcUrl[:restUrl]`), and
 * `getInstance` mutates the shared instance — do NOT construct a separate read/full client against a key
 * this client already holds. Always `dispose()` each client; the shared clients tear down only once the
 * last holder disposes.
 *
 * @remarks
 * On Node, this base factory does NOT guard provider HTTP by default — prefer
 * `createFredClientNode` from `@manifest-network/manifest-mcp-fred/node` (re-exported by the
 * SDK as `@manifest-network/manifest-sdk/node`), which injects an SSRF-guarded fetch.
 * Injecting your own `opts.fetch` opts out of the guard.
 */
export async function createFredClient(
  opts: FullClientOptions,
): Promise<FredClient> {
  if (
    !warnedUnguarded &&
    shouldWarnUnguarded(
      opts.fetch !== undefined,
      typeof process !== 'undefined' && !!process.versions?.node,
    )
  ) {
    warnedUnguarded = true;
    logger.warn(UNGUARDED_FETCH_WARNING);
  }
  const client = await createManifestClient(opts);
  const providerAuth = createProviderAuth(client.signer, {
    chainId: client.chain.getConfig().chainId,
  });
  // Attach providerAuth FIRST so the client object satisfies FredAuthCtx, then layer the bound
  // provider methods over that SAME object (it IS the ctx the actions close over).
  const withAuth = Object.assign(client, { providerAuth }) as FredClient;
  return Object.assign(withAuth, fredActions(withAuth));
}
