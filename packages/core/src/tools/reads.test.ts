import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { describe, expect, it, vi } from 'vitest';
import { makeMockQueryClient, makeReadCtx } from '../__test-utils__/mocks.js';
import type { CosmosClientManager } from '../client.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import {
  getLease,
  getLeaseByCustomDomain,
  getLeasesByTenant,
  getProviders,
  getSKUs,
} from './reads.js';

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

describe('getLeaseByCustomDomain', () => {
  it('returns a branded lease + serviceName', async () => {
    const client = makeMockQueryClient();
    const result = await getLeaseByCustomDomain(
      makeReadCtx({ query: client }),
      'app.example.com',
    );
    // brands erase at runtime — values pass through unchanged
    expect(result.lease.uuid).toBe('lease-uuid-1');
    expect(result.lease.tenant).toBe('manifest1tenant');
    expect(result.lease.providerUuid).toBe('provider-uuid-1');
    expect(result.serviceName).toBe('web');
    expect(
      vi.mocked(client.liftedinit.billing.v1.leaseByCustomDomain),
    ).toHaveBeenCalledWith({ customDomain: 'app.example.com' });
  });

  it('wraps a non-ManifestMCPError rejection as QUERY_FAILED with customDomain context', async () => {
    const client = makeMockQueryClient();
    vi.mocked(
      client.liftedinit.billing.v1.leaseByCustomDomain,
    ).mockRejectedValueOnce(new Error('boom'));
    await expect(
      getLeaseByCustomDomain(makeReadCtx({ query: client }), 'app.example.com'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      details: { customDomain: 'app.example.com' },
    });
  });

  it('rethrows a ManifestMCPError untouched', async () => {
    const client = makeMockQueryClient();
    const original = new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'already mapped',
    );
    vi.mocked(
      client.liftedinit.billing.v1.leaseByCustomDomain,
    ).mockRejectedValueOnce(original);
    await expect(
      getLeaseByCustomDomain(makeReadCtx({ query: client }), 'app.example.com'),
    ).rejects.toBe(original);
  });

  it('acquires the rate-limit token exactly once', async () => {
    const client = makeMockQueryClient();
    const acquireRateLimit = vi.fn();
    const ctx = makeReadCtx({
      query: client,
      chain: { acquireRateLimit } as unknown as CosmosClientManager,
    });
    await getLeaseByCustomDomain(ctx, 'app.example.com');
    expect(acquireRateLimit).toHaveBeenCalledTimes(1);
  });
});

describe('getSKUs', () => {
  it('returns branded SKUs and calls the wire method with {activeOnly} only', async () => {
    const client = makeMockQueryClient({
      sku: {
        skus: [
          { uuid: 'sku-uuid-1', name: 'web', providerUuid: 'provider-uuid-1' },
        ],
      },
    });
    const result = await getSKUs(makeReadCtx({ query: client }), {
      activeOnly: true,
    });
    expect(result).toHaveLength(1);
    // brands erase at runtime — values pass through unchanged
    expect(result[0].uuid).toBe('sku-uuid-1');
    expect(result[0].providerUuid).toBe('provider-uuid-1');
    expect(vi.mocked(client.liftedinit.sku.v1.sKUs)).toHaveBeenCalledWith({
      activeOnly: true,
    });
  });

  it('defaults activeOnly to true when omitted', async () => {
    const client = makeMockQueryClient();
    await getSKUs(makeReadCtx({ query: client }), {});
    expect(vi.mocked(client.liftedinit.sku.v1.sKUs)).toHaveBeenCalledWith({
      activeOnly: true,
    });
  });

  it('acquires the rate-limit token exactly once', async () => {
    const client = makeMockQueryClient();
    const acquireRateLimit = vi.fn();
    const ctx = makeReadCtx({
      query: client,
      chain: { acquireRateLimit } as unknown as CosmosClientManager,
    });
    await getSKUs(ctx, { activeOnly: true });
    expect(acquireRateLimit).toHaveBeenCalledTimes(1);
  });
});

describe('getProviders', () => {
  it('returns branded providers (address + payoutAddress) and calls the wire method with {activeOnly} only', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [
          {
            uuid: 'provider-uuid-1',
            address: 'manifest1provider',
            payoutAddress: 'manifest1payout',
            apiUrl: 'https://provider.example.com',
            active: true,
          },
        ],
      },
    });
    const result = await getProviders(makeReadCtx({ query: client }), {
      activeOnly: true,
    });
    expect(result).toHaveLength(1);
    // brands erase at runtime — values pass through unchanged
    expect(result[0].uuid).toBe('provider-uuid-1');
    expect(result[0].address).toBe('manifest1provider');
    expect(result[0].payoutAddress).toBe('manifest1payout');
    expect(vi.mocked(client.liftedinit.sku.v1.providers)).toHaveBeenCalledWith({
      activeOnly: true,
    });
  });

  it('defaults activeOnly to true when omitted', async () => {
    const client = makeMockQueryClient();
    await getProviders(makeReadCtx({ query: client }), {});
    expect(vi.mocked(client.liftedinit.sku.v1.providers)).toHaveBeenCalledWith({
      activeOnly: true,
    });
  });

  it('acquires the rate-limit token exactly once', async () => {
    const client = makeMockQueryClient();
    const acquireRateLimit = vi.fn();
    const ctx = makeReadCtx({
      query: client,
      chain: { acquireRateLimit } as unknown as CosmosClientManager,
    });
    await getProviders(ctx, { activeOnly: true });
    expect(acquireRateLimit).toHaveBeenCalledTimes(1);
  });
});
