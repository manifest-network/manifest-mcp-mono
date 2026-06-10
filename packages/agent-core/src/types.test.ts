import { describe, expectTypeOf, it } from 'vitest';
import type {
  AgentCoreRuntime,
  CloseLeaseCallbacks,
  CloseLeaseOptions,
  CloseLeaseResult,
  Coin,
  CosmosClientManager,
  DenomLookup,
  DenomMap,
  DeployAppCallbacks,
  DeployAppOptions,
  DeploymentPlanBlock,
  DeployResult,
  DeploySpec,
  FailureEnvelope,
  FeeEstimate,
  LeaseStateName,
  ManageDomainArgs,
  ManageDomainCallbacks,
  ManageDomainOptions,
  ManageDomainResult,
  Plan,
  PlanEdit,
  PlanFees,
  ProgressEvent,
  Readiness,
  ReadinessAction,
  RecoveryChoice,
  RecoveryOption,
  RecoveryOptionId,
  ServiceDef,
  SingleServiceSpec,
  SkuCandidate,
  SpecSummary,
  StackSpec,
  TroubleshootCallbacks,
  TroubleshootOptions,
  TroubleshootReport,
  WalletProvider,
} from './index.js';

describe('DeployAppCallbacks contract', () => {
  it('onPlan(plan) returns Promise<PlanEdit | "confirm" | "cancel">', () => {
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onPlan']>
    >().parameters.toEqualTypeOf<[Plan]>();
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onPlan']>
    >().returns.resolves.toEqualTypeOf<PlanEdit | 'confirm' | 'cancel'>();
  });

  it('onConfirm(block) returns Promise<"yes" | "no">', () => {
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onConfirm']>
    >().parameters.toEqualTypeOf<[DeploymentPlanBlock]>();
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onConfirm']>
    >().returns.resolves.toEqualTypeOf<'yes' | 'no'>();
  });

  it('onProgress(event) returns void synchronously', () => {
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onProgress']>
    >().parameters.toEqualTypeOf<[ProgressEvent]>();
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onProgress']>
    >().returns.toEqualTypeOf<void>();
  });

  it('onComplete(result) returns void synchronously', () => {
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onComplete']>
    >().parameters.toEqualTypeOf<[DeployResult]>();
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onComplete']>
    >().returns.toEqualTypeOf<void>();
  });

  it('onFailure(failure, options) returns Promise<RecoveryChoice>', () => {
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onFailure']>
    >().parameters.toEqualTypeOf<[FailureEnvelope, RecoveryOption[]]>();
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onFailure']>
    >().returns.resolves.toEqualTypeOf<RecoveryChoice>();
  });

  it('onResolveSku(candidates) returns Promise<{ skuUuid: string; providerUuid: string }>', () => {
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onResolveSku']>
    >().parameters.toEqualTypeOf<[SkuCandidate[]]>();
    expectTypeOf<
      NonNullable<DeployAppCallbacks['onResolveSku']>
    >().returns.resolves.toEqualTypeOf<{
      skuUuid: string;
      providerUuid: string;
    }>();
  });
});

describe('ProgressEvent discriminant', () => {
  it('kind union is exactly the eleven allowed variants', () => {
    expectTypeOf<ProgressEvent['kind']>().toEqualTypeOf<
      | 'readiness_evaluated'
      | 'deployment_plan_rendered'
      | 'user_confirmed'
      | 'deploy_app_broadcast'
      | 'deploy_response_classified'
      | 'polling_for_readiness'
      | 'app_ready_confirmed'
      | 'manifest_saved'
      | 'success_rendered'
      | 'partial_success_prompt_rendered'
      | 'sku_ambiguous'
    >();
  });

  it('readiness_evaluated carries Readiness', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'readiness_evaluated' }>
    >().toEqualTypeOf<{ kind: 'readiness_evaluated'; readiness: Readiness }>();
  });

  it('deployment_plan_rendered carries DeploymentPlanBlock', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'deployment_plan_rendered' }>
    >().toEqualTypeOf<{
      kind: 'deployment_plan_rendered';
      block: DeploymentPlanBlock;
    }>();
  });

  it('user_confirmed has no payload', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'user_confirmed' }>
    >().toEqualTypeOf<{ kind: 'user_confirmed' }>();
  });

  it('deploy_app_broadcast has optional leaseUuid', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'deploy_app_broadcast' }>
    >().toEqualTypeOf<{ kind: 'deploy_app_broadcast'; leaseUuid?: string }>();
  });

  it('deploy_response_classified narrows outcome union', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'deploy_response_classified' }>
    >().toEqualTypeOf<{
      kind: 'deploy_response_classified';
      outcome: 'active' | 'needs_wait' | 'failed';
    }>();
  });

  it('polling_for_readiness carries leaseUuid + attempt + elapsedMs + optional state', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'polling_for_readiness' }>
    >().toEqualTypeOf<{
      kind: 'polling_for_readiness';
      leaseUuid: string;
      attempt: number;
      elapsedMs: number;
      state?: LeaseStateName;
    }>();
  });

  it('app_ready_confirmed carries leaseUuid', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'app_ready_confirmed' }>
    >().toEqualTypeOf<{ kind: 'app_ready_confirmed'; leaseUuid: string }>();
  });

  it('manifest_saved carries leaseUuid + manifestPath', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'manifest_saved' }>
    >().toEqualTypeOf<{
      kind: 'manifest_saved';
      leaseUuid: string;
      manifestPath: string;
    }>();
  });

  it('success_rendered carries DeployResult', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'success_rendered' }>
    >().toEqualTypeOf<{ kind: 'success_rendered'; result: DeployResult }>();
  });

  it('partial_success_prompt_rendered carries prompt + leaseUuid', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'partial_success_prompt_rendered' }>
    >().toEqualTypeOf<{
      kind: 'partial_success_prompt_rendered';
      prompt: string;
      leaseUuid: string;
    }>();
  });

  it('sku_ambiguous carries SkuCandidate[]', () => {
    expectTypeOf<
      Extract<ProgressEvent, { kind: 'sku_ambiguous' }>
    >().toEqualTypeOf<{ kind: 'sku_ambiguous'; candidates: SkuCandidate[] }>();
  });
});

describe('FailureEnvelope discriminant', () => {
  it('outcome union is exactly partially_succeeded | failed', () => {
    expectTypeOf<FailureEnvelope['outcome']>().toEqualTypeOf<
      'partially_succeeded' | 'failed'
    >();
  });

  it('partially_succeeded variant has lease + reason + optional requestedCustomDomain', () => {
    expectTypeOf<
      Extract<FailureEnvelope, { outcome: 'partially_succeeded' }>
    >().toEqualTypeOf<{
      outcome: 'partially_succeeded';
      leaseUuid: string;
      requestedCustomDomain?: string;
      reason: string;
    }>();
  });

  it('failed variant has reason only', () => {
    expectTypeOf<
      Extract<FailureEnvelope, { outcome: 'failed' }>
    >().toEqualTypeOf<{ outcome: 'failed'; reason: string }>();
  });
});

describe('RecoveryOption literal id set', () => {
  it('matches the four-id union and pins RecoveryOption.id to it', () => {
    expectTypeOf<RecoveryOptionId>().toEqualTypeOf<
      | 'retry_set_domain'
      | 'salvage_without_domain'
      | 'cancel_lease'
      | 'close_lease'
    >();
    expectTypeOf<RecoveryOption['id']>().toEqualTypeOf<RecoveryOptionId>();
    expectTypeOf<RecoveryChoice['id']>().toEqualTypeOf<RecoveryOptionId>();
  });
});

describe('ManageDomain contract', () => {
  it('args action union is set | clear | lookup', () => {
    expectTypeOf<ManageDomainArgs['action']>().toEqualTypeOf<
      'set' | 'clear' | 'lookup'
    >();
  });

  it('result action union is exactly set | clear | lookup', () => {
    expectTypeOf<ManageDomainResult['action']>().toEqualTypeOf<
      'set' | 'clear' | 'lookup'
    >();
  });

  it('lookup result discriminant carries fqdn + nullable lease', () => {
    expectTypeOf<
      Extract<ManageDomainResult, { action: 'lookup' }>
    >().toEqualTypeOf<{
      action: 'lookup';
      fqdn: string;
      lease: { leaseUuid: string } | null;
    }>();
  });

  it('set result discriminant carries leaseUuid + verified + finalCustomDomain', () => {
    expectTypeOf<
      Extract<ManageDomainResult, { action: 'set' }>
    >().toEqualTypeOf<{
      action: 'set';
      leaseUuid: string;
      verified: boolean;
      finalCustomDomain: string | null;
    }>();
  });

  it('clear result discriminant carries leaseUuid + verified + finalCustomDomain', () => {
    expectTypeOf<
      Extract<ManageDomainResult, { action: 'clear' }>
    >().toEqualTypeOf<{
      action: 'clear';
      leaseUuid: string;
      verified: boolean;
      finalCustomDomain: string | null;
    }>();
  });

  it('callback surface omits onPlan (deploy-only)', () => {
    expectTypeOf<keyof ManageDomainCallbacks>().toEqualTypeOf<
      'onConfirm' | 'onProgress' | 'onComplete' | 'onFailure'
    >();
  });
});

describe('Simple-callback surfaces (manage-domain / troubleshoot / close-lease)', () => {
  it('ManageDomainCallbacks pins each hook signature', () => {
    expectTypeOf<
      NonNullable<ManageDomainCallbacks['onConfirm']>
    >().parameters.toEqualTypeOf<[DeploymentPlanBlock]>();
    expectTypeOf<
      NonNullable<ManageDomainCallbacks['onConfirm']>
    >().returns.resolves.toEqualTypeOf<'yes' | 'no'>();
    expectTypeOf<
      NonNullable<ManageDomainCallbacks['onProgress']>
    >().parameters.toEqualTypeOf<[ProgressEvent]>();
    expectTypeOf<
      NonNullable<ManageDomainCallbacks['onProgress']>
    >().returns.toEqualTypeOf<void>();
    expectTypeOf<
      NonNullable<ManageDomainCallbacks['onComplete']>
    >().parameters.toEqualTypeOf<[ManageDomainResult]>();
    expectTypeOf<
      NonNullable<ManageDomainCallbacks['onComplete']>
    >().returns.toEqualTypeOf<void>();
    expectTypeOf<
      NonNullable<ManageDomainCallbacks['onFailure']>
    >().parameters.toEqualTypeOf<[{ reason: string }]>();
    expectTypeOf<
      NonNullable<ManageDomainCallbacks['onFailure']>
    >().returns.resolves.toEqualTypeOf<void>();
  });

  it('TroubleshootCallbacks pins keys and each hook signature', () => {
    expectTypeOf<keyof TroubleshootCallbacks>().toEqualTypeOf<
      'onConfirm' | 'onProgress' | 'onComplete' | 'onFailure'
    >();
    expectTypeOf<
      NonNullable<TroubleshootCallbacks['onConfirm']>
    >().parameters.toEqualTypeOf<[DeploymentPlanBlock]>();
    expectTypeOf<
      NonNullable<TroubleshootCallbacks['onConfirm']>
    >().returns.resolves.toEqualTypeOf<'yes' | 'no'>();
    expectTypeOf<
      NonNullable<TroubleshootCallbacks['onProgress']>
    >().parameters.toEqualTypeOf<[ProgressEvent]>();
    expectTypeOf<
      NonNullable<TroubleshootCallbacks['onProgress']>
    >().returns.toEqualTypeOf<void>();
    expectTypeOf<
      NonNullable<TroubleshootCallbacks['onComplete']>
    >().parameters.toEqualTypeOf<[TroubleshootReport]>();
    expectTypeOf<
      NonNullable<TroubleshootCallbacks['onComplete']>
    >().returns.toEqualTypeOf<void>();
    expectTypeOf<
      NonNullable<TroubleshootCallbacks['onFailure']>
    >().parameters.toEqualTypeOf<[{ reason: string }]>();
    expectTypeOf<
      NonNullable<TroubleshootCallbacks['onFailure']>
    >().returns.resolves.toEqualTypeOf<void>();
  });

  it('CloseLeaseCallbacks pins keys and each hook signature', () => {
    expectTypeOf<keyof CloseLeaseCallbacks>().toEqualTypeOf<
      'onConfirm' | 'onProgress' | 'onComplete' | 'onFailure'
    >();
    expectTypeOf<
      NonNullable<CloseLeaseCallbacks['onConfirm']>
    >().parameters.toEqualTypeOf<[DeploymentPlanBlock]>();
    expectTypeOf<
      NonNullable<CloseLeaseCallbacks['onConfirm']>
    >().returns.resolves.toEqualTypeOf<'yes' | 'no'>();
    expectTypeOf<
      NonNullable<CloseLeaseCallbacks['onProgress']>
    >().parameters.toEqualTypeOf<[ProgressEvent]>();
    expectTypeOf<
      NonNullable<CloseLeaseCallbacks['onProgress']>
    >().returns.toEqualTypeOf<void>();
    expectTypeOf<
      NonNullable<CloseLeaseCallbacks['onComplete']>
    >().parameters.toEqualTypeOf<[CloseLeaseResult]>();
    expectTypeOf<
      NonNullable<CloseLeaseCallbacks['onComplete']>
    >().returns.toEqualTypeOf<void>();
    expectTypeOf<
      NonNullable<CloseLeaseCallbacks['onFailure']>
    >().parameters.toEqualTypeOf<[{ reason: string }]>();
    expectTypeOf<
      NonNullable<CloseLeaseCallbacks['onFailure']>
    >().returns.resolves.toEqualTypeOf<void>();
  });
});

describe('Exported type shapes (load-bearing public surface)', () => {
  it('Coin', () => {
    expectTypeOf<Coin>().toEqualTypeOf<{ denom: string; amount: string }>();
  });

  it('FeeEstimate', () => {
    expectTypeOf<FeeEstimate>().toEqualTypeOf<{
      coins: Coin[];
      gas: number;
    }>();
  });

  it('DenomLookup', () => {
    expectTypeOf<DenomLookup>().toEqualTypeOf<{
      symbol: string;
      exponent: number;
    }>();
  });

  it('DenomMap', () => {
    expectTypeOf<DenomMap>().toEqualTypeOf<{
      lookup(denom: string): DenomLookup | null;
      raw: unknown;
    }>();
  });

  it('AgentCoreRuntime', () => {
    expectTypeOf<AgentCoreRuntime>().toEqualTypeOf<{
      clientManager: CosmosClientManager;
      fetchFn?: typeof globalThis.fetch;
    }>();
  });

  it('DeployAppOptions extends AgentCoreRuntime with walletProvider + denomMap + dataDir + waitForReadyTimeoutMs fields', () => {
    expectTypeOf<DeployAppOptions>().toEqualTypeOf<{
      clientManager: CosmosClientManager;
      fetchFn?: typeof globalThis.fetch;
      walletProvider: WalletProvider;
      chainDataFile?: string;
      denomMap?: DenomMap;
      dataDir?: string;
      waitForReadyTimeoutMs?: number;
    }>();
  });

  it('ManageDomainOptions extends AgentCoreRuntime with denomMap fields (no walletProvider)', () => {
    expectTypeOf<ManageDomainOptions>().toEqualTypeOf<{
      clientManager: CosmosClientManager;
      fetchFn?: typeof globalThis.fetch;
      chainDataFile?: string;
      denomMap?: DenomMap;
    }>();
  });

  it('CloseLeaseOptions extends AgentCoreRuntime with denomMap fields (no walletProvider)', () => {
    expectTypeOf<CloseLeaseOptions>().toEqualTypeOf<{
      clientManager: CosmosClientManager;
      fetchFn?: typeof globalThis.fetch;
      chainDataFile?: string;
      denomMap?: DenomMap;
    }>();
  });

  it('TroubleshootOptions extends AgentCoreRuntime with denomMap fields (no walletProvider)', () => {
    expectTypeOf<TroubleshootOptions>().toEqualTypeOf<{
      clientManager: CosmosClientManager;
      fetchFn?: typeof globalThis.fetch;
      chainDataFile?: string;
      denomMap?: DenomMap;
    }>();
  });

  it('WalletProvider re-exported from core (presence check; shape owned by core)', () => {
    // The interface itself is defined in `@manifest-network/manifest-mcp-core`'s
    // types.ts; agent-core re-exports it for caller convenience. We assert that
    // the re-export is non-empty (not `any`, not `never`) without re-asserting
    // its full shape — that contract is core's to own.
    expectTypeOf<WalletProvider>().not.toBeAny();
    expectTypeOf<WalletProvider>().not.toBeNever();
    // Verify the ADR-036 surface stays optional (Path-Bii respects this).
    //
    // Copilot review fix (PR #58 r3267583201): the prior assertion was
    // tautological (`X.toEqualTypeOf<X>()` is trivially true for any X)
    // — it would still pass if `signArbitrary` became required. The
    // canonical optionality probe in `expectTypeOf` is "is `undefined`
    // a valid value of the type?", expressed via `toMatchTypeOf`.
    // Mutation-verified: removing the `?` from `signArbitrary` in
    // `core/src/types.ts` breaks this assertion (`undefined` no longer
    // matches `WalletProvider['signArbitrary']`).
    expectTypeOf<undefined>().toMatchTypeOf<WalletProvider['signArbitrary']>();
  });

  it('CosmosClientManager re-exported from core (presence check; shape owned by core)', () => {
    // Class type re-exported from core for type-import convenience. Same as
    // WalletProvider — agent-core verifies the re-export resolves, not the
    // class's full shape.
    expectTypeOf<CosmosClientManager>().not.toBeAny();
    expectTypeOf<CosmosClientManager>().not.toBeNever();
  });

  it('ServiceDef', () => {
    expectTypeOf<ServiceDef>().toEqualTypeOf<{
      image: string;
      ports?: number[];
      env?: Record<string, string>;
      args?: string[];
      command?: string[];
    }>();
  });

  it('SingleServiceSpec', () => {
    // `size?` is a first-class optional field (ENG-275): the SKU / compute
    // tier, defaulting to 'small' in `requestedSize` when omitted.
    // `providerUuid?` / `skuUuid?` are the typed SKU disambiguators
    // (ENG-296), threaded into `resolveSku`.
    expectTypeOf<SingleServiceSpec>().toEqualTypeOf<{
      image: string;
      port?: number | number[];
      env?: Record<string, string>;
      customDomain?: string;
      size?: string;
      providerUuid?: string;
      skuUuid?: string;
    }>();
  });

  it('StackSpec', () => {
    // `size?` mirrors SingleServiceSpec (ENG-275); `providerUuid?` /
    // `skuUuid?` mirror the ENG-296 disambiguators; see above.
    expectTypeOf<StackSpec>().toEqualTypeOf<{
      services: Record<string, ServiceDef>;
      customDomain?: string;
      serviceName?: string;
      size?: string;
      providerUuid?: string;
      skuUuid?: string;
    }>();
  });

  it('DeploySpec is the union of SingleServiceSpec | StackSpec', () => {
    expectTypeOf<DeploySpec>().toEqualTypeOf<SingleServiceSpec | StackSpec>();
  });

  it('SpecSummary', () => {
    expectTypeOf<SpecSummary>().toEqualTypeOf<{
      format: 'single' | 'stack';
      serviceCount: number;
      portCount: number;
      envCount: number;
      envKeys: string[];
      images: string[];
    }>();
  });

  it('ReadinessAction literal union', () => {
    expectTypeOf<ReadinessAction>().toEqualTypeOf<
      'fund_credit' | 'request_faucet' | 'topup_wallet' | 'pick_different_sku'
    >();
  });

  it('Readiness', () => {
    expectTypeOf<Readiness>().toEqualTypeOf<{
      status: 'ok' | 'warn' | 'block';
      reasons: string[];
      suggestedActions: ReadinessAction[];
      walletBalances: Coin[];
      credits: { availableBalances: Coin[] } | null;
      sku: { name: string; price: Coin } | null;
    }>();
  });

  it('PlanFees', () => {
    expectTypeOf<PlanFees>().toEqualTypeOf<{
      createLease: FeeEstimate;
      setDomain?: FeeEstimate | { notEstimated: true; reason: string };
    }>();
  });

  it('Plan', () => {
    expectTypeOf<Plan>().toEqualTypeOf<{
      summary: SpecSummary;
      readiness: Readiness;
      fees: PlanFees;
    }>();
  });

  it('DeploymentPlanBlock', () => {
    expectTypeOf<DeploymentPlanBlock>().toEqualTypeOf<{ text: string }>();
  });

  it('LeaseStateName literal union (matches the chain proto enum)', () => {
    expectTypeOf<LeaseStateName>().toEqualTypeOf<
      | 'LEASE_STATE_UNSPECIFIED'
      | 'LEASE_STATE_PENDING'
      | 'LEASE_STATE_ACTIVE'
      | 'LEASE_STATE_INSUFFICIENT_FUNDS'
      | 'LEASE_STATE_CLOSED'
      | 'LEASE_STATE_REJECTED'
      | 'LEASE_STATE_EXPIRED'
    >();
  });

  it('DeployResult', () => {
    expectTypeOf<DeployResult>().toEqualTypeOf<{
      leaseUuid: string;
      providerUuid: string;
      leaseState: LeaseStateName;
      urls: string[];
      customDomain?: string;
      manifestPath: string;
    }>();
  });

  it('TroubleshootReport', () => {
    expectTypeOf<TroubleshootReport>().toEqualTypeOf<{ markdown: string }>();
  });

  it('CloseLeaseResult', () => {
    expectTypeOf<CloseLeaseResult>().toEqualTypeOf<{
      leaseUuid: string;
      finalState: LeaseStateName;
    }>();
  });
});
