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
});
