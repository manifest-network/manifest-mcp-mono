import { describe, expectTypeOf, it } from 'vitest';
import type { Address, LeaseUuid } from './brands.js';
import type { getLease, getLeasesByTenant } from './tools/reads.js';

// §9:258 read-boundary fixtures — the typed reads return CORE-OWNED branded view types, so the
// branded scoped ids survive to the fn boundary. getLease returns `BrandedLease | null`, so index
// through NonNullable<…> to reach the branded fields.
describe('read-boundary fn return types (type-level)', () => {
  it('getLease return-type brands the scoped ids (through NonNullable)', () => {
    expectTypeOf<
      NonNullable<Awaited<ReturnType<typeof getLease>>>['uuid']
    >().toEqualTypeOf<LeaseUuid>();
    expectTypeOf<
      NonNullable<Awaited<ReturnType<typeof getLease>>>['tenant']
    >().toEqualTypeOf<Address>();
  });
  it('getLeasesByTenant return-type brands the per-lease uuid (§9:258)', () => {
    expectTypeOf<
      Awaited<ReturnType<typeof getLeasesByTenant>>['leases'][number]['uuid']
    >().toEqualTypeOf<LeaseUuid>();
  });
});
