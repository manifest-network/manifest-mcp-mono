// Public type contract for @manifest-network/manifest-agent-core.
//
// Frozen surface for ENG-128 (bootstrap). Function bodies arrive in ENG-129.
// See ENG-127 for the broader initiative.

import type {
  CosmosClientManager,
  WalletProvider,
} from '@manifest-network/manifest-mcp-core';

// Re-export workspace-dep types so public consumers can import them from
// `@manifest-network/manifest-agent-core` directly without a separate
// `manifest-mcp-core` dependency. These are TS-type-only re-exports; the
// runtime bundle is unaffected (platform: 'neutral' build target preserved).
export type { CosmosClientManager, WalletProvider };

// --- primitives ---------------------------------------------------------

export interface Coin {
  denom: string;
  amount: string;
}

export interface FeeEstimate {
  coins: Coin[];
  gas: number;
}

// --- denom map ---------------------------------------------------------
//
// Promoted from `internals/humanize-denom.ts` for public consumption by
// PR-3 `deployApp` / PR-4 `manageDomain` / `closeLease` /
// `troubleshootDeployment`. Callers (plugin / Barney / tests) construct
// the map via `loadChainDenomMap(chainDataFile)` or stub it directly for
// tests; agent-core's public functions accept it as injectable input
// alongside per-call options (per Path-Bii "I/O at orchestrator boundary"
// principle).

export interface DenomLookup {
  symbol: string;
  exponent: number;
}

export interface DenomMap {
  /** Look up a denom by string; returns `null` for unknown denoms. */
  lookup(denom: string): DenomLookup | null;
  /** Raw chain-registry JSON when loaded from `chainDataFile`; `null` for stub/empty maps. */
  raw: unknown;
}

// --- agent-core runtime context (PR-3 commit B) -----------------------
//
// Per architect's E-hybrid verdict (post-PR-3 sub-plan Q5; "Architect
// verdict: Option E with hybrid base"):
//
//   - `AgentCoreRuntime` is the minimal shared base for all 4 public
//     function options. Callers construct it once per session and
//     spread it into per-call options.
//   - Per-function options extend `AgentCoreRuntime` with whatever
//     extra fields that function specifically needs. Only `deployApp`
//     requires `walletProvider` (ADR-036 auth tokens for the manifest
//     upload via fred's atomic deployApp tool); the other 3 stay
//     base + chainDataFile/denomMap.
//   - "I/O at orchestrator boundary" principle preserved (Path-Bii):
//     callers compose the runtime; agent-core's public functions stay
//     consumers of injected dependencies, not constructors.
//
// Caller-side ergonomics:
//
//   const runtime: AgentCoreRuntime = { clientManager, fetchFn };
//   const denomMap = await loadChainDenomMap(chainDataFile);
//   await deployApp(spec, cb, { ...runtime, walletProvider, denomMap });
//   await manageDomain(args, cb, { ...runtime, denomMap });
//   await closeLease(args, cb, { ...runtime });

/**
 * Shared runtime resources required by all four public agent-core
 * functions. Build once per caller-session; spread into per-call options.
 */
export interface AgentCoreRuntime {
  /** Cosmos chain client (signing + querying). Plugin/Barney bind their own wallet at construction. */
  clientManager: CosmosClientManager;
  /** Optional fetch implementation; defaults to `globalThis.fetch` inside fred's deployApp. */
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Per-call options for `deployApp`. Extends `AgentCoreRuntime` with the
 * deploy-only `walletProvider` (ADR-036 auth-token construction) plus
 * the optional DenomMap injection (chain-registry-driven humanization).
 */
export interface DeployAppOptions extends AgentCoreRuntime {
  /**
   * Wallet provider for ADR-036 auth-token signing.
   *
   * **MUST** implement `signArbitrary` — validated at the call boundary
   * with `ManifestMCPError(INVALID_CONFIG)` thrown if absent. agent-core
   * constructs the auth-token callbacks internally from this wallet
   * (using fred's `createAuthToken` + `createSignMessage` +
   * `createLeaseDataSignMessage` primitives + `AuthTimestampTracker`
   * for monotonic replay-safe timestamps). Keeps the plugin/Barney
   * surface clean (no ADR-036 plumbing required from callers).
   *
   * The `signArbitrary` return shape must match the cosmjs convention:
   *
   *   `{ pub_key: { type: string, value: string }, signature: string }`
   *
   * where `pub_key.value` is the base64-encoded public-key bytes and
   * `signature` is the base64-encoded signature. Non-cosmjs
   * `WalletProvider` implementations (e.g. one returning
   * `pub_key.value` as `Uint8Array`) would silently miscompose the
   * persisted token; we rely on the convention rather than a runtime
   * guard today.
   */
  walletProvider: WalletProvider;
  /** Path to `$MANIFEST_PLUGIN_DATA/chains/<chain>.json` for denom humanization. */
  chainDataFile?: string;
  /** Pre-loaded `DenomMap` (wins over `chainDataFile` when both supplied). */
  denomMap?: DenomMap;
  /**
   * Optional directory for persisting the deployment manifest after a
   * successful deploy. When provided, the orchestrator passes it to
   * `saveManifest()` (`internals/save-manifest.ts`); see that function's
   * `dataDir` JSDoc for the security-posture requirements (chmod-
   * tightening implications — pass a dedicated subdirectory, NOT a
   * shared parent like `$HOME`). When absent, persistence is skipped
   * and the orchestrator still emits the success path per step-16's
   * "save-fail still emits success" contract.
   */
  dataDir?: string;
}

/**
 * Per-call options for `manageDomain` (PR 4). Doesn't broadcast through
 * fred → no `walletProvider` required. Just the runtime base +
 * humanization injection.
 */
export interface ManageDomainOptions extends AgentCoreRuntime {
  chainDataFile?: string;
  denomMap?: DenomMap;
}

/**
 * Per-call options for `closeLease` (PR 4). Doesn't broadcast through
 * fred → no `walletProvider` required.
 */
export interface CloseLeaseOptions extends AgentCoreRuntime {
  chainDataFile?: string;
  denomMap?: DenomMap;
}

/**
 * Per-call options for `troubleshootDeployment` (PR 4). Doesn't
 * broadcast through fred → no `walletProvider` required.
 */
export interface TroubleshootOptions extends AgentCoreRuntime {
  chainDataFile?: string;
  denomMap?: DenomMap;
}

// --- deployment specs ---------------------------------------------------

export interface ServiceDef {
  image: string;
  ports?: number[];
  env?: Record<string, string>;
  args?: string[];
  command?: string[];
}

export interface SingleServiceSpec {
  image: string;
  port?: number | number[];
  env?: Record<string, string>;
  customDomain?: string;
}

export interface StackSpec {
  services: Record<string, ServiceDef>;
  customDomain?: string;
  serviceName?: string;
}

export type DeploySpec = SingleServiceSpec | StackSpec;

export interface SpecSummary {
  format: 'single' | 'stack';
  serviceCount: number;
  portCount: number;
  envCount: number;
  envKeys: string[];
  images: string[];
}

// --- readiness ----------------------------------------------------------

export type ReadinessAction =
  | 'fund_credit'
  | 'request_faucet'
  | 'topup_wallet'
  | 'pick_different_sku';

export interface Readiness {
  status: 'ok' | 'warn' | 'block';
  reasons: string[];
  suggestedActions: ReadinessAction[];
  walletBalances: Coin[];
  credits: { availableBalances: Coin[] } | null;
  sku: { name: string; price: Coin } | null;
}

// --- plan ---------------------------------------------------------------

export interface PlanFees {
  createLease: FeeEstimate;
  setDomain?: FeeEstimate | { notEstimated: true; reason: string };
}

export interface Plan {
  summary: SpecSummary;
  readiness: Readiness;
  fees: PlanFees;
}

export type PlanEdit =
  | { kind: 'edit_env'; service?: string; env: Record<string, string> }
  | { kind: 'replace_spec'; spec: DeploySpec };

export interface DeploymentPlanBlock {
  text: string;
}

// --- lease state --------------------------------------------------------

export type LeaseStateName =
  | 'LEASE_STATE_UNSPECIFIED'
  | 'LEASE_STATE_PENDING'
  | 'LEASE_STATE_ACTIVE'
  | 'LEASE_STATE_INSUFFICIENT_FUNDS'
  | 'LEASE_STATE_CLOSED'
  | 'LEASE_STATE_REJECTED'
  | 'LEASE_STATE_EXPIRED';

// --- deploy result ------------------------------------------------------

export interface DeployResult {
  leaseUuid: string;
  providerUuid: string;
  leaseState: LeaseStateName;
  urls: string[];
  customDomain?: string;
  manifestPath: string;
}

// --- progress events ----------------------------------------------------

export type ProgressEvent =
  | { kind: 'readiness_evaluated'; readiness: Readiness }
  | { kind: 'deployment_plan_rendered'; block: DeploymentPlanBlock }
  | { kind: 'user_confirmed' }
  | { kind: 'deploy_app_broadcast'; leaseUuid?: string }
  | {
      kind: 'deploy_response_classified';
      outcome: 'active' | 'needs_wait' | 'failed';
    }
  | { kind: 'app_ready_confirmed'; leaseUuid: string }
  | { kind: 'manifest_saved'; leaseUuid: string; manifestPath: string }
  | { kind: 'success_rendered'; result: DeployResult };

// --- failure + recovery -------------------------------------------------

export type FailureEnvelope =
  | {
      outcome: 'partially_succeeded';
      leaseUuid: string;
      requestedCustomDomain?: string;
      reason: string;
    }
  | { outcome: 'failed'; reason: string };

export type RecoveryOptionId =
  | 'retry_set_domain'
  | 'salvage_without_domain'
  | 'cancel_lease'
  | 'close_lease';

export interface RecoveryOption {
  id: RecoveryOptionId;
  label: string;
  description: string;
}

export interface RecoveryChoice {
  id: RecoveryOptionId;
}

// --- callbacks: deploy --------------------------------------------------

export interface DeployAppCallbacks {
  onPlan?: (plan: Plan) => Promise<PlanEdit | 'confirm' | 'cancel'>;
  onConfirm?: (block: DeploymentPlanBlock) => Promise<'yes' | 'no'>;
  onProgress?: (event: ProgressEvent) => void;
  onComplete?: (result: DeployResult) => void;
  onFailure?: (
    failure: FailureEnvelope,
    options: RecoveryOption[],
  ) => Promise<RecoveryChoice>;
}

// --- manage-domain ------------------------------------------------------

export type ManageDomainArgs =
  | { action: 'set'; leaseUuid: string; fqdn: string; serviceName?: string }
  | { action: 'clear'; leaseUuid: string; serviceName?: string }
  | { action: 'lookup'; fqdn: string };

export type ManageDomainResult =
  | {
      action: 'set';
      leaseUuid: string;
      verified: boolean;
      finalCustomDomain: string | null;
    }
  | {
      action: 'clear';
      leaseUuid: string;
      verified: boolean;
      finalCustomDomain: string | null;
    }
  | { action: 'lookup'; fqdn: string; lease: { leaseUuid: string } | null };

export interface ManageDomainCallbacks {
  onConfirm?: (block: DeploymentPlanBlock) => Promise<'yes' | 'no'>;
  onProgress?: (event: ProgressEvent) => void;
  onComplete?: (result: ManageDomainResult) => void;
  onFailure?: (failure: { reason: string }) => Promise<void>;
}

// --- troubleshoot -------------------------------------------------------

export interface TroubleshootArgs {
  leaseUuid: string;
}

export interface TroubleshootReport {
  markdown: string;
}

export interface TroubleshootCallbacks {
  onConfirm?: (block: DeploymentPlanBlock) => Promise<'yes' | 'no'>;
  onProgress?: (event: ProgressEvent) => void;
  onComplete?: (result: TroubleshootReport) => void;
  onFailure?: (failure: { reason: string }) => Promise<void>;
}

// --- close-lease --------------------------------------------------------

export interface CloseLeaseArgs {
  leaseUuid: string;
}

export interface CloseLeaseResult {
  leaseUuid: string;
  finalState: LeaseStateName;
}

export interface CloseLeaseCallbacks {
  onConfirm?: (block: DeploymentPlanBlock) => Promise<'yes' | 'no'>;
  onProgress?: (event: ProgressEvent) => void;
  onComplete?: (result: CloseLeaseResult) => void;
  onFailure?: (failure: { reason: string }) => Promise<void>;
}
