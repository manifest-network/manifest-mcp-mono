import { describe, expectTypeOf, it } from 'vitest';
import type {
  Address,
  Fqdn,
  LeaseUuid,
  ProviderUuid,
  SkuUuid,
} from './brands.js';
import type {
  BrandedLease,
  BrandedProvider,
  BrandedSKU,
  DeployResult,
  FredLeaseStatus,
  PortConfig,
} from './manifest-types.js';

describe('manifest-types shape (type-level)', () => {
  it('FredLeaseStatus.state keeps the manifestjs LeaseState enum (number), not string', () => {
    expectTypeOf<FredLeaseStatus['state']>().toExtend<number>();
  });
  it('PortConfig is the net-new ENG-282 shape', () => {
    expectTypeOf<PortConfig>().toEqualTypeOf<{
      readonly host_port?: number;
      readonly ingress?: boolean;
    }>();
  });
  it('DeployResult id-fields are branded (3b-1)', () => {
    expectTypeOf<DeployResult['lease_uuid']>().toEqualTypeOf<
      import('./brands.js').LeaseUuid
    >();
    expectTypeOf<DeployResult['provider_uuid']>().toEqualTypeOf<
      import('./brands.js').ProviderUuid
    >();
    expectTypeOf<DeployResult['lease_uuid']>().toExtend<string>(); // still erases to string (non-breaking)
  });
  it('BrandedLease brands the full scoped-id set (uuid/tenant/providerUuid + item ids)', () => {
    expectTypeOf<BrandedLease['uuid']>().toEqualTypeOf<LeaseUuid>();
    expectTypeOf<BrandedLease['tenant']>().toEqualTypeOf<Address>();
    expectTypeOf<BrandedLease['providerUuid']>().toEqualTypeOf<ProviderUuid>();
    expectTypeOf<
      BrandedLease['items'][number]['skuUuid']
    >().toEqualTypeOf<SkuUuid>();
    expectTypeOf<
      BrandedLease['items'][number]['customDomain']
    >().toEqualTypeOf<Fqdn>();
    // brands still erase to string (non-breaking)
    expectTypeOf<BrandedLease['uuid']>().toExtend<string>();
    expectTypeOf<BrandedLease['tenant']>().toExtend<string>();
    expectTypeOf<BrandedLease['providerUuid']>().toExtend<string>();
    expectTypeOf<BrandedLease['items'][number]['skuUuid']>().toExtend<string>();
    expectTypeOf<
      BrandedLease['items'][number]['customDomain']
    >().toExtend<string>();
  });
  it('BrandedSKU brands uuid + providerUuid', () => {
    expectTypeOf<BrandedSKU['uuid']>().toEqualTypeOf<SkuUuid>();
    expectTypeOf<BrandedSKU['providerUuid']>().toEqualTypeOf<ProviderUuid>();
    expectTypeOf<BrandedSKU['uuid']>().toExtend<string>();
    expectTypeOf<BrandedSKU['providerUuid']>().toExtend<string>();
  });
  it('BrandedProvider brands uuid + address + payoutAddress', () => {
    expectTypeOf<BrandedProvider['uuid']>().toEqualTypeOf<ProviderUuid>();
    expectTypeOf<BrandedProvider['address']>().toEqualTypeOf<Address>();
    expectTypeOf<BrandedProvider['payoutAddress']>().toEqualTypeOf<Address>();
    expectTypeOf<BrandedProvider['uuid']>().toExtend<string>();
    expectTypeOf<BrandedProvider['address']>().toExtend<string>();
    expectTypeOf<BrandedProvider['payoutAddress']>().toExtend<string>();
  });
  it('AppDeploySpec / ManifestDeploySpec are data-only (no runtime fields)', () => {
    type App = import('./manifest-types.js').AppDeploySpec;
    type Man = import('./manifest-types.js').ManifestDeploySpec;
    expectTypeOf<App>().not.toHaveProperty('gasMultiplier');
    expectTypeOf<App>().not.toHaveProperty('onLeaseCreated');
    expectTypeOf<App>().not.toHaveProperty('abortSignal');
    expectTypeOf<App>().not.toHaveProperty('pollOptions');
    expectTypeOf<Man>().not.toHaveProperty('gasMultiplier');
    expectTypeOf<Man>().not.toHaveProperty('onLeaseCreated');
    expectTypeOf<Man>().not.toHaveProperty('abortSignal');
    expectTypeOf<Man>().not.toHaveProperty('pollOptions');
    expectTypeOf<Man['sku']>().toEqualTypeOf<
      import('./manifest-types.js').SkuIntent
    >();
  });
  it('SkuIntent uuids are branded; size is plain string', () => {
    type ByName = Extract<
      import('./manifest-types.js').SkuIntent,
      { kind: 'byName' }
    >;
    expectTypeOf<ByName['size']>().toEqualTypeOf<string>();
    expectTypeOf<ByName['providerUuid']>().toEqualTypeOf<
      import('./brands.js').ProviderUuid | undefined
    >();
    type Resolved = Extract<
      import('./manifest-types.js').SkuIntent,
      { kind: 'resolved' }
    >;
    expectTypeOf<Resolved['skuUuid']>().toEqualTypeOf<
      import('./brands.js').SkuUuid
    >();
    expectTypeOf<Resolved['providerUuid']>().toEqualTypeOf<
      import('./brands.js').ProviderUuid
    >();
  });
});
