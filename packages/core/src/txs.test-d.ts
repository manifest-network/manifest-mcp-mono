import { describe, expectTypeOf, it } from 'vitest';
import type { Address, Fqdn, LeaseUuid } from './brands.js';
import type { FundCreditsResult } from './tools/fundCredits.js';
import type { SetItemCustomDomainResult } from './tools/setItemCustomDomain.js';
import type { StopAppResult } from './tools/stopApp.js';

// §5.5/§5.8 tx-boundary fixtures — the typed txs return CORE-OWNED branded result types, so the
// branded scoped ids survive to the fn boundary. Each branded field is asserted to be its exact
// brand AND to still extend `string` (brands erase to their base type — a consumer can pass a result
// id straight back into a string slot).
describe('tx-result fn return types (type-level)', () => {
  it('FundCreditsResult brands sender/tenant as Address', () => {
    expectTypeOf<FundCreditsResult['sender']>().toEqualTypeOf<Address>();
    expectTypeOf<FundCreditsResult['sender']>().toExtend<string>();
    expectTypeOf<FundCreditsResult['tenant']>().toEqualTypeOf<Address>();
    expectTypeOf<FundCreditsResult['tenant']>().toExtend<string>();
  });

  it('SetItemCustomDomainResult brands lease_uuid as LeaseUuid and custom_domain as Fqdn', () => {
    expectTypeOf<
      SetItemCustomDomainResult['lease_uuid']
    >().toEqualTypeOf<LeaseUuid>();
    expectTypeOf<SetItemCustomDomainResult['lease_uuid']>().toExtend<string>();
    expectTypeOf<
      SetItemCustomDomainResult['custom_domain']
    >().toEqualTypeOf<Fqdn>();
    expectTypeOf<
      SetItemCustomDomainResult['custom_domain']
    >().toExtend<string>();
  });

  it('StopAppResult brands lease_uuid as LeaseUuid', () => {
    expectTypeOf<StopAppResult['lease_uuid']>().toEqualTypeOf<LeaseUuid>();
    expectTypeOf<StopAppResult['lease_uuid']>().toExtend<string>();
  });

  it('StopAppResult discriminates on outcome and ties rejection_reason to REJECTED', () => {
    type R = StopAppResult;
    // outcome narrows the tx fields:
    type Stopped = Extract<R, { outcome: 'stopped' }>;
    expectTypeOf<Stopped['transactionHash']>().toEqualTypeOf<string>();
    expectTypeOf<
      Stopped['lease_state']
    >().toEqualTypeOf<'LEASE_STATE_CLOSED'>();

    // already_inactive has NO transactionHash on any sub-arm:
    type Inactive = Extract<R, { outcome: 'already_inactive' }>;
    expectTypeOf<Inactive>().not.toHaveProperty('transactionHash');

    // rejection_reason is REQUIRED on the REJECTED sub-arm, ABSENT on the others:
    type InactiveRejected = Extract<
      Inactive,
      { lease_state: 'LEASE_STATE_REJECTED' }
    >;
    expectTypeOf<
      InactiveRejected['rejection_reason']
    >().toEqualTypeOf<string>();
    // Extract on BOTH non-rejected literals — a single literal would Extract to `never`
    // (the arm's lease_state is the union), and expectTypeOf<never>().not.toHaveProperty(..)
    // fails to typecheck. Guard that regression, then assert the property absence.
    type InactiveClosed = Extract<
      Inactive,
      { lease_state: 'LEASE_STATE_CLOSED' | 'LEASE_STATE_EXPIRED' }
    >;
    expectTypeOf<InactiveClosed>().not.toEqualTypeOf<never>();
    expectTypeOf<InactiveClosed>().not.toHaveProperty('rejection_reason');
  });
});
