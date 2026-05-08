import { describe, expectTypeOf, it } from 'vitest';
import type {
  CloseLeaseCallbacks,
  CloseLeaseResult,
  DeployAppCallbacks,
  DeploymentPlanBlock,
  DeployResult,
  FailureEnvelope,
  ManageDomainArgs,
  ManageDomainCallbacks,
  ManageDomainResult,
  Plan,
  PlanEdit,
  ProgressEvent,
  Readiness,
  RecoveryChoice,
  RecoveryOption,
  RecoveryOptionId,
  TroubleshootCallbacks,
  TroubleshootReport,
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
});

describe('ProgressEvent discriminant', () => {
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
});

describe('FailureEnvelope discriminant', () => {
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
  it('action union is set | clear | lookup', () => {
    expectTypeOf<ManageDomainArgs['action']>().toEqualTypeOf<
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
