import { describe, it, expect, vi, beforeEach } from 'vitest';
import { browseCatalog } from './browseCatalog.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';

vi.mock('../http/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/provider.js')>();
  return {
    ...actual,
    getProviderHealth: vi.fn(),
  };
});

import { getProviderHealth } from '../http/provider.js';
import { ProviderApiError } from '../http/provider.js';

const mockGetProviderHealth = vi.mocked(getProviderHealth);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('browseCatalog', () => {
  it('returns providers with health status (healthy provider)', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [
          { uuid: 'p1', address: 'manifest1prov', apiUrl: 'https://prov.example.com', active: true },
        ],
        skus: [],
      },
    });
    mockGetProviderHealth.mockResolvedValue({ status: 'ok', provider_uuid: 'p1-uuid' });

    const result = await browseCatalog(client);

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toEqual({
      uuid: 'p1',
      address: 'manifest1prov',
      apiUrl: 'https://prov.example.com',
      active: true,
      healthy: true,
      providerUuid: 'p1-uuid',
    });
  });

  it('also treats "healthy" status as healthy', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [
          { uuid: 'p1', address: 'manifest1prov', apiUrl: 'https://prov.example.com', active: true },
        ],
        skus: [],
      },
    });
    mockGetProviderHealth.mockResolvedValue({ status: 'healthy', provider_uuid: 'p1-uuid' });

    const result = await browseCatalog(client);
    expect(result.providers[0].healthy).toBe(true);
  });

  it('handles provider health check failure (sets healthError)', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [
          { uuid: 'p1', address: 'manifest1prov', apiUrl: 'https://prov.example.com', active: true },
        ],
        skus: [],
      },
    });
    mockGetProviderHealth.mockRejectedValue(new ProviderApiError(503, 'Service Unavailable'));

    const result = await browseCatalog(client);

    expect(result.providers[0].healthy).toBe(false);
    expect(result.providers[0].healthError).toBe('HTTP 503: Service Unavailable');
  });

  it('re-throws unexpected non-ProviderApiError errors from health check', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [
          { uuid: 'p1', address: 'manifest1prov', apiUrl: 'https://prov.example.com', active: true },
        ],
        skus: [],
      },
    });
    mockGetProviderHealth.mockRejectedValue(new TypeError('Cannot read properties of undefined'));

    await expect(browseCatalog(client)).rejects.toThrow(TypeError);
  });

  it('groups SKUs into tiers by name', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [
          { uuid: 'prov-1', address: 'manifest1p1', apiUrl: 'https://p1.example.com', active: true },
        ],
        skus: [
          { name: 'small', providerUuid: 'prov-1', basePrice: { amount: '100', denom: 'umfx' } },
          { name: 'small', providerUuid: 'prov-1', basePrice: { amount: '110', denom: 'umfx' } },
          { name: 'large', providerUuid: 'prov-1', basePrice: { amount: '500', denom: 'umfx' } },
        ],
      },
    });
    mockGetProviderHealth.mockResolvedValue({ status: 'ok', provider_uuid: 'prov-1' });

    const result = await browseCatalog(client);

    expect(Object.keys(result.tiers)).toEqual(['small', 'large']);
    expect(result.tiers['small']).toHaveLength(2);
    expect(result.tiers['large']).toHaveLength(1);
  });

  it('maps provider UUID to apiUrl in tiers', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [
          { uuid: 'prov-1', address: 'manifest1p1', apiUrl: 'https://p1.example.com', active: true },
        ],
        skus: [
          { name: 'small', providerUuid: 'prov-1', basePrice: { amount: '100', denom: 'umfx' } },
        ],
      },
    });
    mockGetProviderHealth.mockResolvedValue({ status: 'ok', provider_uuid: 'prov-1' });

    const result = await browseCatalog(client);

    expect(result.tiers['small'][0].provider).toBe('https://p1.example.com');
  });

  it('uses providerUuid as fallback when provider not found in map', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [],
        skus: [
          { name: 'small', providerUuid: 'unknown-prov', basePrice: { amount: '100', denom: 'umfx' } },
        ],
      },
    });

    const result = await browseCatalog(client);

    expect(result.tiers['small'][0].provider).toBe('unknown-prov');
  });

  it('handles empty providers/SKUs', async () => {
    const client = makeMockQueryClient({
      sku: { providers: [], skus: [] },
    });

    const result = await browseCatalog(client);

    expect(result.providers).toEqual([]);
    expect(result.tiers).toEqual({});
  });

  it('handles null basePrice fields', async () => {
    const client = makeMockQueryClient({
      sku: {
        providers: [],
        skus: [
          { name: 'free', providerUuid: 'p1' },
        ],
      },
    });

    const result = await browseCatalog(client);

    expect(result.tiers['free'][0].price).toBeNull();
    expect(result.tiers['free'][0].unit).toBeNull();
  });
});
