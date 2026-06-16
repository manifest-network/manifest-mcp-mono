import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { describe, expect, it, vi } from 'vitest';
import { makeMockQueryClient, makeReadCtx } from '../__test-utils__/mocks.js';
import type { CosmosClientManager } from '../client.js';
import { getLease, getLeasesByTenant } from './reads.js';

describe('getLeasesByTenant', () => {
  it('returns branded leases + total and assembles the PageRequest (countTotal)', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          {
            uuid: 'lease-uuid-1',
            providerUuid: 'provider-uuid-1',
            createdAt: new Date(0),
          },
        ],
      },
    });
    const result = await getLeasesByTenant(makeReadCtx({ query: client }), {
      tenant: 'manifest1tenant',
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
    });
    expect(result.leases).toHaveLength(1);
    // brands erase at runtime — values pass through unchanged
    expect(result.leases[0].uuid).toBe('lease-uuid-1');
    expect(result.leases[0].providerUuid).toBe('provider-uuid-1');
    // the leasesByTenant mock fixture omits items — the runtime guard materializes []
    expect(result.leases[0].items).toEqual([]);
    expect(
      vi.mocked(client.liftedinit.billing.v1.leasesByTenant),
    ).toHaveBeenCalledWith({
      tenant: 'manifest1tenant',
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
      pagination: {
        key: new Uint8Array(),
        offset: 0n,
        limit: 50n,
        countTotal: true,
        reverse: false,
      },
    });
  });

  it('falls back total to 0n when pagination is absent', async () => {
    const client = makeMockQueryClient();
    const result = await getLeasesByTenant(makeReadCtx({ query: client }), {
      tenant: 'manifest1tenant',
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
    });
    expect(result.total).toBe(0n);
  });

  it('honours limit/offset when supplied', async () => {
    const client = makeMockQueryClient();
    await getLeasesByTenant(makeReadCtx({ query: client }), {
      tenant: 'manifest1tenant',
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
      limit: 10n,
      offset: 5n,
    });
    expect(
      vi.mocked(client.liftedinit.billing.v1.leasesByTenant),
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        pagination: expect.objectContaining({ offset: 5n, limit: 10n }),
      }),
    );
  });

  it('acquires the rate-limit token exactly once', async () => {
    const client = makeMockQueryClient();
    const acquireRateLimit = vi.fn();
    const ctx = makeReadCtx({
      query: client,
      chain: { acquireRateLimit } as unknown as CosmosClientManager,
    });
    await getLeasesByTenant(ctx, {
      tenant: 'manifest1tenant',
      stateFilter: LeaseState.LEASE_STATE_ACTIVE,
    });
    expect(acquireRateLimit).toHaveBeenCalledTimes(1);
  });
});

describe('getLease', () => {
  it('returns a branded lease', async () => {
    const client = makeMockQueryClient({
      billing: {
        lease: {
          uuid: 'lease-uuid-1',
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'provider-uuid-1',
          createdAt: new Date(0),
        },
      },
    });
    const result = await getLease(
      makeReadCtx({ query: client }),
      'lease-uuid-1',
    );
    expect(result).not.toBeNull();
    expect(result?.uuid).toBe('lease-uuid-1');
    expect(result?.providerUuid).toBe('provider-uuid-1');
    // partial fixture omits items — the runtime guard materializes []
    expect(result?.items).toEqual([]);
  });

  it('returns null when the chain returns {lease: null}', async () => {
    const client = makeMockQueryClient();
    const result = await getLease(makeReadCtx({ query: client }), 'missing');
    expect(result).toBeNull();
  });

  it('acquires the rate-limit token exactly once', async () => {
    const client = makeMockQueryClient({
      billing: {
        lease: {
          uuid: 'lease-uuid-1',
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'provider-uuid-1',
          createdAt: new Date(0),
        },
      },
    });
    const acquireRateLimit = vi.fn();
    const ctx = makeReadCtx({
      query: client,
      chain: { acquireRateLimit } as unknown as CosmosClientManager,
    });
    await getLease(ctx, 'lease-uuid-1');
    expect(acquireRateLimit).toHaveBeenCalledTimes(1);
  });
});
