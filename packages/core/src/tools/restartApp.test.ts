import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../http/fred.js', () => ({
  restartLease: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveLeaseProvider: vi.fn(),
}));

import { restartApp } from './restartApp.js';
import { restartLease } from '../http/fred.js';
import { resolveLeaseProvider } from './resolveLeaseProvider.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const mockRestartLease = vi.mocked(restartLease);
const mockResolveLeaseProvider = vi.mocked(resolveLeaseProvider);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('restartApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves provider from chain and restarts the lease', async () => {
    const qc = makeMockQueryClient();
    mockResolveLeaseProvider.mockResolvedValue({
      providerUuid: 'prov-1',
      providerUrl: 'https://provider.example.com',
      leaseState: 2,
    });
    mockRestartLease.mockResolvedValue({ status: 'restarting' });

    const result = await restartApp(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(mockResolveLeaseProvider).toHaveBeenCalledWith(qc, 'lease-1');
    expect(mockRestartLease).toHaveBeenCalledWith(
      'https://provider.example.com',
      'lease-1',
      'auth-token-123',
    );
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      status: 'restarting',
    });
  });

  it('throws when lease not found on chain', async () => {
    const qc = makeMockQueryClient();
    mockResolveLeaseProvider.mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'Lease "lease-1" not found on chain'),
    );

    await expect(
      restartApp(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });

  it('throws when lease is closed', async () => {
    const qc = makeMockQueryClient();
    mockResolveLeaseProvider.mockResolvedValue({
      providerUuid: 'prov-1',
      providerUrl: 'https://provider.example.com',
      leaseState: 3,
    });

    await expect(
      restartApp(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('closed'),
    });

    expect(mockRestartLease).not.toHaveBeenCalled();
  });

  it('lets auth errors propagate', async () => {
    const qc = makeMockQueryClient();
    mockResolveLeaseProvider.mockResolvedValue({
      providerUuid: 'prov-1',
      providerUrl: 'https://provider.example.com',
      leaseState: 2,
    });

    const authError = new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
      'signArbitrary not supported',
    );
    const failingGetAuthToken = vi.fn().mockRejectedValue(authError);

    await expect(
      restartApp(qc, ADDRESS, 'lease-1', failingGetAuthToken),
    ).rejects.toBe(authError);
  });
});
