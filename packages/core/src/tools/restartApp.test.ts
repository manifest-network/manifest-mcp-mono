import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';

vi.mock('../http/fred.js', () => ({
  restartLease: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { restartApp } from './restartApp.js';
import { restartLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const mockRestartLease = vi.mocked(restartLease);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('restartApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
  });

  it('queries lease, resolves provider URL, and restarts the lease', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockRestartLease.mockResolvedValue({ status: 'restarting' });

    const result = await restartApp(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(mockResolveProviderUrl).toHaveBeenCalledWith(qc, 'prov-1');
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
    const qc = makeMockQueryClient({
      billing: { lease: null },
    });

    await expect(
      restartApp(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not found on chain'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
  });

  it('throws when lease is closed without resolving provider', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_CLOSED, providerUuid: 'prov-1' },
      },
    });

    await expect(
      restartApp(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockRestartLease).not.toHaveBeenCalled();
  });

  it('throws when lease is rejected without resolving provider', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_REJECTED, providerUuid: 'prov-1' },
      },
    });

    await expect(
      restartApp(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockRestartLease).not.toHaveBeenCalled();
  });

  it('throws when lease is expired without resolving provider', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_EXPIRED, providerUuid: 'prov-1' },
      },
    });

    await expect(
      restartApp(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockRestartLease).not.toHaveBeenCalled();
  });

  it('lets auth errors propagate', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
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
