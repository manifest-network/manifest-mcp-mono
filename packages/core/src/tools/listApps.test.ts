import { describe, it, expect, beforeEach } from 'vitest';
import { listApps } from './listApps.js';
import { InMemoryAppRegistry } from '../registry.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';

const ADDRESS = 'manifest1user';

describe('listApps', () => {
  let registry: InMemoryAppRegistry;

  beforeEach(() => {
    registry = new InMemoryAppRegistry();
  });

  it('fetches and merges active + pending leases into registry', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-active', providerUuid: 'prov-1', createdAt: new Date('2025-01-01') },
        ],
        pendingLeases: [
          { uuid: 'lease-pending', providerUuid: 'prov-1', createdAt: new Date('2025-01-02') },
        ],
      },
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'https://provider.example.com' } },
        },
      },
    });

    const result = await listApps(client, ADDRESS, registry);

    expect(result.count).toBe(2);
    expect(result.apps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ leaseUuid: 'lease-active', status: 'active' }),
        expect.objectContaining({ leaseUuid: 'lease-pending', status: 'pending' }),
      ]),
    );
  });

  it('reconciles: marks registry apps as stopped when lease disappears from chain', async () => {
    // Pre-populate registry with an app whose lease is no longer on chain
    registry.addApp(ADDRESS, {
      name: 'old-app',
      leaseUuid: 'lease-gone',
      status: 'active',
    });

    const client = makeMockQueryClient({
      billing: { activeLeases: [], pendingLeases: [] },
    });

    await listApps(client, ADDRESS, registry);

    const app = registry.getApp(ADDRESS, 'old-app');
    expect(app.status).toBe('stopped');
  });

  it('does not re-mark already stopped apps', async () => {
    registry.addApp(ADDRESS, {
      name: 'stopped-app',
      leaseUuid: 'lease-stopped',
      status: 'stopped',
    });

    const client = makeMockQueryClient({
      billing: { activeLeases: [], pendingLeases: [] },
    });

    // Should not throw or cause issues
    await listApps(client, ADDRESS, registry);
    const app = registry.getApp(ADDRESS, 'stopped-app');
    expect(app.status).toBe('stopped');
  });

  it('resolves provider URLs from SKU module', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [{ uuid: 'lease-1', providerUuid: 'prov-1' }],
        pendingLeases: [],
      },
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'https://provider1.example.com' } },
        },
      },
    });

    await listApps(client, ADDRESS, registry);

    const app = registry.getAppByLease(ADDRESS, 'lease-1');
    expect(app?.providerUrl).toBe('https://provider1.example.com');
  });

  it('handles provider lookup failure gracefully (leaves providerUrl unset)', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [{ uuid: 'lease-1', providerUuid: 'unknown-prov' }],
        pendingLeases: [],
      },
      sku: {
        providerLookup: {}, // no provider matches
      },
    });

    await listApps(client, ADDRESS, registry);

    const app = registry.getAppByLease(ADDRESS, 'lease-1');
    expect(app).toBeDefined();
    expect(app!.providerUrl).toBeUndefined();
  });

  it('creates new registry entries for unknown leases (name = uuid prefix)', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [{ uuid: 'abcdef12-3456-7890-abcd-ef1234567890', providerUuid: 'p1' }],
        pendingLeases: [],
      },
      sku: { providerLookup: {} },
    });

    await listApps(client, ADDRESS, registry);

    const app = registry.getAppByLease(ADDRESS, 'abcdef12-3456-7890-abcd-ef1234567890');
    expect(app).toBeDefined();
    expect(app!.name).toBe('abcdef12');
  });

  it('updates existing registry entries with fresh status', async () => {
    // App in registry is pending, but chain says active
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      status: 'pending',
    });

    const client = makeMockQueryClient({
      billing: {
        activeLeases: [{ uuid: 'lease-1', providerUuid: 'p1' }],
        pendingLeases: [],
      },
      sku: { providerLookup: {} },
    });

    await listApps(client, ADDRESS, registry);

    const app = registry.getApp(ADDRESS, 'my-app');
    expect(app.status).toBe('active');
  });

  it('does not overwrite existing providerUrl when provider lookup succeeds', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://existing.example.com',
      status: 'active',
    });

    const client = makeMockQueryClient({
      billing: {
        activeLeases: [{ uuid: 'lease-1', providerUuid: 'p1' }],
        pendingLeases: [],
      },
      sku: {
        providerLookup: {
          'p1': { provider: { apiUrl: 'https://new.example.com' } },
        },
      },
    });

    await listApps(client, ADDRESS, registry);

    const app = registry.getApp(ADDRESS, 'my-app');
    expect(app.providerUrl).toBe('https://existing.example.com');
  });

  it('returns empty list when no leases exist', async () => {
    const client = makeMockQueryClient({
      billing: { activeLeases: [], pendingLeases: [] },
    });

    const result = await listApps(client, ADDRESS, registry);

    expect(result.apps).toEqual([]);
    expect(result.count).toBe(0);
  });
});
