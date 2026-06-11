import { describe, expectTypeOf, it } from 'vitest';
import type {
  Address,
  Fqdn,
  LeaseUuid,
  ProviderUuid,
  SkuUuid,
} from './brands.js';
import { asLeaseUuid, asProviderUuid, asSkuUuid } from './brands.js';

// NOTE: never use expectTypeOf(...).branded here — `.branded` normalizes away the
// `& { __brand }` intersection that DEFINES a brand and would defeat these checks.
describe('brand distinctness (type-level)', () => {
  it('UUID-backed brands are mutually non-assignable', () => {
    expectTypeOf<LeaseUuid>().not.toEqualTypeOf<ProviderUuid>();
    expectTypeOf<ProviderUuid>().not.toEqualTypeOf<SkuUuid>();
    expectTypeOf<LeaseUuid>().not.toEqualTypeOf<SkuUuid>();
  });
  it('a non-UUID pair is also distinct', () => {
    expectTypeOf<Address>().not.toEqualTypeOf<Fqdn>();
  });
  it('brands are one-way assignable: TO string, not FROM string', () => {
    expectTypeOf<LeaseUuid>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<LeaseUuid>();
  });
});

describe('as* return the correct branded type (type-level)', () => {
  it('each as* returns its own branded type, mutually distinct', () => {
    expectTypeOf(asProviderUuid('x')).toEqualTypeOf<ProviderUuid>();
    expectTypeOf(asLeaseUuid('x')).toEqualTypeOf<LeaseUuid>();
    expectTypeOf(asSkuUuid('x')).toEqualTypeOf<SkuUuid>();
    expectTypeOf(asProviderUuid('x')).not.toEqualTypeOf<LeaseUuid>();
  });
});
