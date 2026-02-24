import { describe, it, expect, vi, beforeEach } from 'vitest';
import { appStatus } from './appStatus.js';
import { InMemoryAppRegistry } from '../registry.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

vi.mock('../http/fred.js', () => ({
  getLeaseStatus: vi.fn(),
}));

vi.mock('../http/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/provider.js')>();
  return {
    ...actual,
    getLeaseConnectionInfo: vi.fn(),
  };
});

import { getLeaseStatus } from '../http/fred.js';
import { getLeaseConnectionInfo } from '../http/provider.js';

const mockGetLeaseStatus = vi.mocked(getLeaseStatus);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('appStatus', () => {
  let registry: InMemoryAppRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new InMemoryAppRegistry();
  });

  it('returns chain state + fred status + connection info for active lease', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    const client = makeMockQueryClient({
      billing: {
        lease: {
          uuid: 'lease-1',
          state: 2, // ACTIVE
          providerUuid: 'prov-1',
          createdAt: new Date('2025-01-01'),
        },
      },
    });

    mockGetLeaseStatus.mockResolvedValue({ status: 'running', services: { web: { ready: true, available: 1, total: 1 } } });
    mockGetLeaseConnectionInfo.mockResolvedValue({ host: '1.2.3.4', ports: { http: 8080 } });

    const result = await appStatus(client, ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(result.name).toBe('my-app');
    expect(result.status).toBe('active');
    expect(result.chainState).toEqual({
      state: 2,
      providerUuid: 'prov-1',
      createdAt: '2025-01-01T00:00:00.000Z',
      closedAt: undefined,
    });
    expect(result.fredStatus).toEqual({ status: 'running', services: { web: { ready: true, available: 1, total: 1 } } });
    expect(result.connection).toEqual({ host: '1.2.3.4', ports: { http: 8080 } });
  });

  it('skips fred calls when no providerUrl on app', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      status: 'active',
      // no providerUrl
    });

    const client = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: 2, providerUuid: 'prov-1' },
      },
    });

    const result = await appStatus(client, ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(mockGetLeaseStatus).not.toHaveBeenCalled();
    expect(mockGetLeaseConnectionInfo).not.toHaveBeenCalled();
    expect(result.fredStatus).toBeUndefined();
    expect(result.connection).toBeUndefined();
  });

  it('skips fred calls for non-active/pending lease states', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'stopped',
    });

    const client = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: 3, providerUuid: 'prov-1' }, // state 3 = closed
      },
    });

    await appStatus(client, ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(mockGetLeaseStatus).not.toHaveBeenCalled();
    expect(mockGetLeaseConnectionInfo).not.toHaveBeenCalled();
  });

  it('makes fred calls for pending (state=1) leases', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'pending',
    });

    const client = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: 1, providerUuid: 'prov-1' }, // PENDING
      },
    });

    mockGetLeaseStatus.mockResolvedValue({ status: 'provisioning' });
    mockGetLeaseConnectionInfo.mockResolvedValue({ host: '1.2.3.4', ports: {} });

    await appStatus(client, ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(mockGetLeaseStatus).toHaveBeenCalledOnce();
    expect(mockGetLeaseConnectionInfo).toHaveBeenCalledOnce();
  });

  it('captures providerError when fred status call fails', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    const client = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: 2, providerUuid: 'prov-1' },
      },
    });

    mockGetLeaseStatus.mockRejectedValue(new Error('provider down'));
    mockGetLeaseConnectionInfo.mockResolvedValue({ host: '1.2.3.4', ports: {} });

    const result = await appStatus(client, ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(result.providerError).toBe('provider down');
    expect(result.fredStatus).toBeUndefined();
    // Connection info still attempted
    expect(result.connection).toEqual({ host: '1.2.3.4', ports: {} });
  });

  it('captures connectionError when connection info call fails', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    const client = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: 2, providerUuid: 'prov-1' },
      },
    });

    mockGetLeaseStatus.mockResolvedValue({ status: 'running' });
    mockGetLeaseConnectionInfo.mockRejectedValue(new Error('connection refused'));

    const result = await appStatus(client, ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(result.fredStatus).toEqual({ status: 'running' });
    expect(result.connectionError).toBe('connection refused');
    expect(result.connection).toBeUndefined();
  });

  it('lets auth errors propagate (wallet configuration problem)', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    const client = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: 2, providerUuid: 'prov-1' },
      },
    });

    const authError = new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
      'signArbitrary not supported',
    );
    const failingGetAuthToken = vi.fn().mockRejectedValue(authError);

    await expect(
      appStatus(client, ADDRESS, 'my-app', registry, failingGetAuthToken),
    ).rejects.toBe(authError);
  });

  it('throws when app not found in registry', async () => {
    const client = makeMockQueryClient();

    await expect(
      appStatus(client, ADDRESS, 'nonexistent', registry, mockGetAuthToken),
    ).rejects.toThrow(ManifestMCPError);
  });

  it('handles null lease from chain', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    const client = makeMockQueryClient({
      billing: { lease: null },
    });

    const result = await appStatus(client, ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(result.chainState).toBeNull();
    expect(mockGetLeaseStatus).not.toHaveBeenCalled();
  });
});
