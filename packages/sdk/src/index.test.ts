import { describe, expect, it } from 'vitest';
import * as catalog from './catalog.js';
import * as chain from './chain.js';
import * as deploy from './deploy.js';
import * as root from './index.js';
import * as node from './node.js';
import * as orchestration from './orchestration.js';
import * as reads from './reads.js';

/**
 * Barrel-hygiene contract for `@manifest-network/manifest-sdk` (ENG-309). The SDK
 * is a PURE re-export aggregator: a thin ROOT (factories + types + brands + ports
 * + wallet + errors + config, NO free fns) plus scoped subpaths. These assertions
 * pin the public surface AND the browser-safety invariant: the Node-only
 * SSRF-guarded fetch (`createGuardedFetch`/`isBlocked`/`GuardedFetch`) must NOT
 * leak into any browser-safe barrel — it lives ONLY on `./node`. (A Node-run
 * vitest cannot catch a `default:null` resolution chain; the rolldown
 * browser-resolution check in `scripts/browser-resolve.test.ts` is that guard.
 * This file pins the runtime export sets.)
 */

const ROOT_FACTORIES = [
  'createManifestClient',
  'createManifestReadClient',
  'createFredClient',
] as const;

// Free fns belong on subpaths, never on the thin ROOT (also structurally avoids
// the fred-vs-agent-core `deployApp` name clash).
const ROOT_FORBIDDEN_FREE_FNS = [
  'getBalance',
  'deployApp',
  'executeTx',
  'waitForLeaseStatus',
] as const;

const READS = [
  'getBalance',
  'getBillingParams',
  'getLease',
  'getLeaseByCustomDomain',
  'getLeasesByTenant',
  'getProviders',
  'getSKUs',
  'getWithdrawableAmount',
] as const;

const GUARDED_FETCH_EXPORTS = ['createGuardedFetch', 'isBlocked'] as const;

describe('manifest-sdk barrels', () => {
  it('ROOT exposes the client factories, no free fns', () => {
    for (const k of ROOT_FACTORIES) expect(root).toHaveProperty(k);
    for (const k of ROOT_FORBIDDEN_FREE_FNS) expect(root).not.toHaveProperty(k);
  });

  it('ROOT exposes the curated value re-exports (brands, wallet, errors, config)', () => {
    for (const k of [
      'CosmosClientManager',
      'parseAddress',
      'asAddress',
      'createSignerAdapter',
      'requireAuthSigner',
      'MnemonicWalletProvider',
      'signArbitraryWithAmino',
      'ManifestMCPError',
      'ManifestMCPErrorCode',
      'ProviderApiError',
      'isSkuAmbiguousError',
      'INFRASTRUCTURE_ERROR_CODES',
      'sanitizeForLogging',
      'createConfig',
      'validateConfig',
      'createValidatedConfig',
      'resolveCallSignal',
      'VERSION',
    ])
      expect(root).toHaveProperty(k);
  });

  it('/reads exposes the 8 reads', () => {
    for (const k of READS) expect(reads).toHaveProperty(k);
  });

  it('/catalog exposes the catalog value surface', () => {
    for (const k of [
      'resolveSku',
      'listSkuCandidates',
      'browseCatalog',
      'mapWithConcurrency',
      'buildManifestPreview',
      'checkDeploymentReadiness',
    ])
      expect(catalog).toHaveProperty(k);
  });

  it('/deploy exposes the tx + manifest + provider + fred-lease value surface', () => {
    for (const k of [
      'executeTx',
      'fundCredits',
      'setItemCustomDomain',
      'stopApp',
      'LeaseState',
      'leaseStateFromJSON',
      'leaseStateToJSON',
      'deployApp',
      'deployManifest',
      'buildManifest',
      'waitForLeaseStatus',
      'isLeaseFailureTerminal',
      'waitForAppReady',
      'createAuthTokens',
      'createProviderAuth',
    ])
      expect(deploy).toHaveProperty(k);
  });

  it('/orchestration exposes the 5 orchestration value fns', () => {
    for (const k of [
      'deployApp',
      'manageDomain',
      'troubleshootDeployment',
      'closeLease',
      'loadChainDenomMap',
    ])
      expect(orchestration).toHaveProperty(k);
  });

  it('node-only exports are ONLY on /node (browser-safety; ENG-281/287)', () => {
    const NODE_ONLY = [...GUARDED_FETCH_EXPORTS, 'createFredClientNode'];
    for (const b of [root, reads, catalog, deploy, orchestration, chain])
      for (const k of NODE_ONLY) expect(b).not.toHaveProperty(k);
    for (const k of NODE_ONLY) expect(node).toHaveProperty(k);
  });

  // EXACT-KEYSET pins (not just toHaveProperty): catch ADDITIVE drift — a new value silently leaking
  // onto a thin/small barrel (e.g. the `fredActions` over-export). Scoped to the barrels where the
  // exact surface is load-bearing + low-churn (thin ROOT; the small /reads, /orchestration, /node).
  // /catalog + /deploy are intentional growth surfaces — kept on toHaveProperty above.
  // (`Object.keys` sees only VALUE exports; `export type *`/`export type {}` erase at build.)
  const keys = (m: object) => Object.keys(m).sort();

  it('ROOT runtime exports are EXACTLY the curated value set (thin barrel, no drift)', () => {
    expect(keys(root)).toEqual(
      [
        ...ROOT_FACTORIES,
        'CosmosClientManager',
        'parseAddress',
        'parseFqdn',
        'parseLeaseUuid',
        'parseProviderUuid',
        'parseSkuUuid',
        'asAddress',
        'asFqdn',
        'asLeaseUuid',
        'asProviderUuid',
        'asSkuUuid',
        'createSignerAdapter',
        'requireAuthSigner',
        'MnemonicWalletProvider',
        'noopLogger',
        'signArbitraryWithAmino',
        'ManifestMCPError',
        'ManifestMCPErrorCode',
        'ProviderApiError',
        'isSkuAmbiguousError',
        'INFRASTRUCTURE_ERROR_CODES',
        'sanitizeForLogging',
        'createConfig',
        'validateConfig',
        'createValidatedConfig',
        'resolveCallSignal',
        'VERSION',
      ].sort(),
    );
  });

  it('/reads runtime exports are EXACTLY the 8 reads', () => {
    expect(keys(reads)).toEqual([...READS].sort());
  });

  it('/chain runtime exports are EXACTLY the 2 generic escape hatches', () => {
    expect(keys(chain)).toEqual(['cosmosQuery', 'cosmosTx'].sort());
  });

  it('/orchestration runtime exports are EXACTLY the 5 orchestration fns', () => {
    expect(keys(orchestration)).toEqual(
      [
        'deployApp',
        'manageDomain',
        'troubleshootDeployment',
        'closeLease',
        'loadChainDenomMap',
      ].sort(),
    );
  });

  it('/node runtime exports are EXACTLY guarded-fetch + WS transport + createFredClientNode', () => {
    expect(keys(node)).toEqual(
      [
        'createFredClientNode',
        'createNodeEventTransport',
        ...GUARDED_FETCH_EXPORTS,
      ].sort(),
    );
  });
});
