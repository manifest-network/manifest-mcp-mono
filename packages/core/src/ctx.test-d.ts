import { describe, expectTypeOf, it } from 'vitest';
import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import type { CapabilityCtx, EventTransport, QueryCtx } from './ctx.js';
import type { Logger } from './logger.js';
import type { Signer } from './signer.js';

describe('CapabilityCtx / QueryCtx (type-level)', () => {
  it('CapabilityCtx is exactly the 6 fields with the real types', () => {
    expectTypeOf<CapabilityCtx['chain']>().toEqualTypeOf<CosmosClientManager>();
    expectTypeOf<CapabilityCtx['query']>().toEqualTypeOf<ManifestQueryClient>();
    expectTypeOf<CapabilityCtx['signer']>().toEqualTypeOf<Signer | undefined>();
    expectTypeOf<CapabilityCtx['fetch']>().toEqualTypeOf<
      typeof globalThis.fetch
    >();
    expectTypeOf<CapabilityCtx['logger']>().toEqualTypeOf<Logger>();
    expectTypeOf<CapabilityCtx['events']>().toEqualTypeOf<
      EventTransport | undefined
    >();
  });
  it('QueryCtx drops only signer; the full ctx extends the query ctx', () => {
    expectTypeOf<QueryCtx>().toHaveProperty('query');
    expectTypeOf<QueryCtx>().not.toHaveProperty('signer');
    expectTypeOf<CapabilityCtx>().toExtend<QueryCtx>(); // full ctx assignable to query ctx
  });
});
