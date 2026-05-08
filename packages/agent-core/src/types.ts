// Public type contract for @manifest-network/manifest-agent-core.
//
// Frozen surface for ENG-128 (bootstrap). Function bodies arrive in ENG-129.
// See ENG-127 for the broader initiative.

// --- primitives ---------------------------------------------------------

export interface Coin {
  denom: string;
  amount: string;
}

export interface FeeEstimate {
  amount: string;
  denom: string;
  gas: number;
  human: string;
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
  setDomain?: FeeEstimate | { not_estimated: true; reason: string };
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
  | 'LEASE_STATE_CLOSED';

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
  | { kind: 'manifest_saved'; leaseUuid: string; path: string }
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
