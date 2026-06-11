import { describe, expectTypeOf, it } from 'vitest';
import type {
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
});
