import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../http/fred.js', () => ({
  restartLease: vi.fn(),
}));

import { restartApp } from './restartApp.js';
import { restartLease } from '../http/fred.js';
import { InMemoryAppRegistry } from '../registry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const mockRestartLease = vi.mocked(restartLease);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('restartApp', () => {
  let registry: InMemoryAppRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new InMemoryAppRegistry();
  });

  it('restarts the lease via provider and returns status', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    mockRestartLease.mockResolvedValue({ status: 'restarting' });

    const result = await restartApp(ADDRESS, 'my-app', registry, mockGetAuthToken);

    expect(mockRestartLease).toHaveBeenCalledWith(
      'https://provider.example.com',
      'lease-1',
      'auth-token-123',
    );
    expect(result).toEqual({
      app_name: 'my-app',
      status: 'restarting',
    });
  });

  it('throws QUERY_FAILED when app has no providerUrl', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      status: 'active',
    });

    await expect(
      restartApp(ADDRESS, 'my-app', registry, mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('no provider URL'),
    });
  });

  it('throws when app not found in registry', async () => {
    await expect(
      restartApp(ADDRESS, 'nonexistent', registry, mockGetAuthToken),
    ).rejects.toThrow(ManifestMCPError);
  });

  it('lets auth errors propagate', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    const authError = new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
      'signArbitrary not supported',
    );
    const failingGetAuthToken = vi.fn().mockRejectedValue(authError);

    await expect(
      restartApp(ADDRESS, 'my-app', registry, failingGetAuthToken),
    ).rejects.toBe(authError);
  });
});
