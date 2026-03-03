import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listApps } from './listApps.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';

const ADDRESS = 'manifest1user';

describe('listApps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns active and pending leases when filter is "all"', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-active', providerUuid: 'prov-1', createdAt: new Date('2025-01-01') },
        ],
        pendingLeases: [
          { uuid: 'lease-pending', providerUuid: 'prov-1', createdAt: new Date('2025-01-02') },
        ],
      },
    });

    const result = await listApps(client, ADDRESS, 'all');

    expect(result.count).toBe(2);
    expect(result.leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uuid: 'lease-active', stateLabel: 'active' }),
        expect.objectContaining({ uuid: 'lease-pending', stateLabel: 'pending' }),
      ]),
    );
  });

  it('returns only active leases when filter is "active"', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-active', providerUuid: 'prov-1' },
        ],
        pendingLeases: [
          { uuid: 'lease-pending', providerUuid: 'prov-1' },
        ],
      },
    });

    const result = await listApps(client, ADDRESS, 'active');

    expect(result.leases).toHaveLength(1);
    expect(result.leases[0].uuid).toBe('lease-active');
  });

  it('returns only pending leases when filter is "pending"', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-active', providerUuid: 'prov-1' },
        ],
        pendingLeases: [
          { uuid: 'lease-pending', providerUuid: 'prov-1' },
        ],
      },
    });

    const result = await listApps(client, ADDRESS, 'pending');

    expect(result.leases).toHaveLength(1);
    expect(result.leases[0].uuid).toBe('lease-pending');
  });

  it('defaults to "all" when no filter specified', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-active', providerUuid: 'prov-1' },
        ],
        pendingLeases: [
          { uuid: 'lease-pending', providerUuid: 'prov-1' },
        ],
      },
    });

    const result = await listApps(client, ADDRESS);

    // "all" includes pending, active, closed, rejected, and expired leases
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  it('returns empty list when no leases exist', async () => {
    const client = makeMockQueryClient({
      billing: { activeLeases: [], pendingLeases: [] },
    });

    const result = await listApps(client, ADDRESS, 'all');

    expect(result.leases).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('includes timestamps in lease info', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-1', providerUuid: 'prov-1', createdAt: new Date('2025-06-15T10:30:00Z') },
        ],
        pendingLeases: [],
      },
    });

    const result = await listApps(client, ADDRESS, 'active');

    expect(result.leases[0].createdAt).toBe('2025-06-15T10:30:00.000Z');
  });

  it('returns rejected leases when filter is "rejected"', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-active', providerUuid: 'prov-1' },
        ],
        rejectedLeases: [
          { uuid: 'lease-rejected', providerUuid: 'prov-1' },
        ],
      },
    });

    const result = await listApps(client, ADDRESS, 'rejected');

    expect(result.leases).toHaveLength(1);
    expect(result.leases[0].uuid).toBe('lease-rejected');
    expect(result.leases[0].stateLabel).toBe('rejected');
  });

  it('returns expired leases when filter is "expired"', async () => {
    const client = makeMockQueryClient({
      billing: {
        expiredLeases: [
          { uuid: 'lease-expired', providerUuid: 'prov-1' },
        ],
      },
    });

    const result = await listApps(client, ADDRESS, 'expired');

    expect(result.leases).toHaveLength(1);
    expect(result.leases[0].uuid).toBe('lease-expired');
    expect(result.leases[0].stateLabel).toBe('expired');
  });

  it('"all" filter includes rejected and expired leases', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-active', providerUuid: 'prov-1' },
        ],
        pendingLeases: [],
        rejectedLeases: [
          { uuid: 'lease-rejected', providerUuid: 'prov-1' },
        ],
        expiredLeases: [
          { uuid: 'lease-expired', providerUuid: 'prov-1' },
        ],
      },
    });

    const result = await listApps(client, ADDRESS, 'all');

    const uuids = result.leases.map(l => l.uuid);
    expect(uuids).toContain('lease-active');
    expect(uuids).toContain('lease-rejected');
    expect(uuids).toContain('lease-expired');
  });

  it('includes providerUuid in lease info', async () => {
    const client = makeMockQueryClient({
      billing: {
        activeLeases: [
          { uuid: 'lease-1', providerUuid: 'provider-abc' },
        ],
        pendingLeases: [],
      },
    });

    const result = await listApps(client, ADDRESS, 'active');

    expect(result.leases[0].providerUuid).toBe('provider-abc');
  });
});
