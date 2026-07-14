import { describe, expectTypeOf, it } from 'vitest';
import type { CosmosClientManager, ManifestQueryClient } from './client.js';
import type {
  CapabilityCtx,
  EventSocket,
  EventTransport,
  QueryCtx,
  ReadCtx,
  TxCtx,
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

describe('EventTransport / EventSocket (type-level)', () => {
  it('EventTransport is an injected WS factory: open(url) => EventSocket', () => {
    expectTypeOf<EventTransport>().toHaveProperty('open');
    expectTypeOf<EventTransport['open']>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<EventTransport['open']>().returns.toEqualTypeOf<EventSocket>();
  });
  it('EventSocket exposes the normalized on*/close handle', () => {
    expectTypeOf<EventSocket>().toHaveProperty('onMessage');
    expectTypeOf<EventSocket>().toHaveProperty('onOpen');
    expectTypeOf<EventSocket>().toHaveProperty('onClose');
    expectTypeOf<EventSocket>().toHaveProperty('onError');
    expectTypeOf<EventSocket>().toHaveProperty('close');
  });
});

describe('TxCtx (type-level)', () => {
  it('TxCtx is the tx ISP slice: chain+signer+logger, NO query/fetch', () => {
    expectTypeOf<TxCtx>().toHaveProperty('chain');
    expectTypeOf<TxCtx>().toHaveProperty('signer');
    expectTypeOf<TxCtx>().toHaveProperty('logger');
    expectTypeOf<TxCtx>().not.toHaveProperty('query');
    expectTypeOf<TxCtx>().not.toHaveProperty('fetch');
    expectTypeOf<CapabilityCtx>().toExtend<TxCtx>();
  });
});
