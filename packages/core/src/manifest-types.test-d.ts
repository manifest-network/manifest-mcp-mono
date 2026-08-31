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
  FredLeaseProvision,
  FredLeaseRelease,
  FredLeaseStatus,
  PortConfig,
  PortMapping,
  ServiceConfig,
} from './manifest-types.js';

describe('manifest-types shape (type-level)', () => {
  it('FredLeaseStatus.state keeps the manifestjs LeaseState enum (number), not string', () => {
    expectTypeOf<FredLeaseStatus['state']>().toExtend<number>();
  });
  it('the ENG-508 failure pair is modelled on all three Fred wire types', () => {
    // The three carry the pair identically (shared FredFailureFields base), so
    // one cannot silently drift from the others.
    expectTypeOf<FredLeaseStatus['reason']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<FredLeaseStatus['message']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<FredLeaseProvision['reason']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<FredLeaseProvision['message']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<FredLeaseRelease['reason']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<FredLeaseRelease['message']>().toEqualTypeOf<
      string | undefined
    >();
  });
  it('`reason` stays an OPEN string, never a closed union (ENG-638)', () => {
    // Fred documents the set as open and add-only. A closed union here would
    // start lying the moment the provider ships a tenth value, and would break
    // any consumer assigning a plain string — the forward-compatibility trap
    // that made Kubernetes strip enums from its OpenAPI snapshot.
    expectTypeOf<string>().toExtend<NonNullable<FredLeaseStatus['reason']>>();
    expectTypeOf<'AnyFutureReasonFredMightShip'>().toExtend<
      NonNullable<FredLeaseStatus['reason']>
    >();
  });
  it('the pre-ENG-508 failure fields are RETAINED as optional (non-breaking)', () => {
    // Removing these would be a breaking change on the published
    // @manifest-network/manifest-sdk/deploy surface while the provider fleet is
    // still mid-upgrade. They are @deprecated, not gone.
    expectTypeOf<FredLeaseStatus['last_error']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<FredLeaseProvision['last_error']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<FredLeaseRelease['error']>().toEqualTypeOf<
      string | undefined
    >();
  });
  it('PortConfig is the net-new ENG-282 shape', () => {
    expectTypeOf<PortConfig>().toEqualTypeOf<{
      readonly host_port?: number;
      readonly ingress?: boolean;
    }>();
  });
  it('ServiceConfig carries the per-service init flag', () => {
    expectTypeOf<ServiceConfig['init']>().toEqualTypeOf<boolean | undefined>();
  });
  it('PortMapping matches the Fred connection wire object', () => {
    expectTypeOf<PortMapping>().toEqualTypeOf<{
      readonly host_ip: string;
      readonly host_port: number;
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
