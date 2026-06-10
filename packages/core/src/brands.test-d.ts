import { describe, expectTypeOf, it } from 'vitest';
import type {
  Denom,
  LeaseUuid,
  ProviderUuid,
  SkuUuid,
  TierName,
} from './brands.js';

// NOTE: never use expectTypeOf(...).branded here — `.branded` normalizes away the
// `& { __brand }` intersection that DEFINES a brand and would defeat these checks.
describe('brand distinctness (type-level)', () => {
  it('UUID-backed brands are mutually non-assignable', () => {
    expectTypeOf<LeaseUuid>().not.toEqualTypeOf<ProviderUuid>();
    expectTypeOf<ProviderUuid>().not.toEqualTypeOf<SkuUuid>();
    expectTypeOf<LeaseUuid>().not.toEqualTypeOf<SkuUuid>();
  });
  it('a non-UUID pair is also distinct', () => {
    expectTypeOf<Denom>().not.toEqualTypeOf<TierName>();
  });
  it('brands are one-way assignable: TO string, not FROM string', () => {
    expectTypeOf<LeaseUuid>().toExtend<string>();
    expectTypeOf<string>().not.toExtend<LeaseUuid>();
  });
});
