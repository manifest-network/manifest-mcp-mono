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
  it('DeployResult ids are plain string in 3a (branding is deferred to 3b)', () => {
    expectTypeOf<DeployResult['lease_uuid']>().toEqualTypeOf<string>();
    expectTypeOf<DeployResult['provider_uuid']>().toEqualTypeOf<string>();
  });
});
