import { describe, expectTypeOf, it } from 'vitest';
import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import type {
  CapabilityCtx,
  EventTransport,
  QueryCtx,
  ReadCtx,
} from './ctx.js';
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

describe('ReadCtx (type-level)', () => {
  it('ReadCtx is the read ISP slice: query+chain+logger, NO signer/fetch', () => {
    expectTypeOf<ReadCtx>().toHaveProperty('query');
    expectTypeOf<ReadCtx>().toHaveProperty('chain');
    expectTypeOf<ReadCtx>().toHaveProperty('logger');
    expectTypeOf<ReadCtx>().not.toHaveProperty('signer');
    expectTypeOf<ReadCtx>().not.toHaveProperty('fetch');
    expectTypeOf<CapabilityCtx>().toExtend<ReadCtx>(); // a full ctx satisfies the read slice
  });
});
