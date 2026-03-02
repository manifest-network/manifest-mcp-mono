import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../http/fred.js', () => ({
  updateLease: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveLeaseProvider: vi.fn(),
}));

import { updateApp } from './updateApp.js';
import { updateLease } from '../http/fred.js';
import { resolveLeaseProvider } from './resolveLeaseProvider.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const mockUpdateLease = vi.mocked(updateLease);
const mockResolveLeaseProvider = vi.mocked(resolveLeaseProvider);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('updateApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveLeaseProvider.mockResolvedValue({
      providerUuid: 'prov-1',
      providerUrl: 'https://provider.example.com',
      leaseState: 2,
    });
  });

  it('resolves provider from chain and updates the lease with given manifest', async () => {
    const qc = makeMockQueryClient();
    const manifest = JSON.stringify({ image: 'nginx:latest', ports: { '80/tcp': {} } });
    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    const result = await updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, manifest);

    expect(mockResolveLeaseProvider).toHaveBeenCalledWith(qc, 'lease-1');
    expect(mockUpdateLease).toHaveBeenCalledWith(
      'https://provider.example.com',
      'lease-1',
      manifest,
      'auth-token-123',
    );
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      status: 'updated',
    });
  });

  it('passes manifest string through without modification', async () => {
    const qc = makeMockQueryClient();
    const manifest = '{"image":"redis:7","ports":{"6379/tcp":{}},"env":{"FOO":"bar"}}';
    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    await updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, manifest);

    expect(mockUpdateLease.mock.calls[0][2]).toBe(manifest);
  });

  it('throws when lease not found on chain', async () => {
    const qc = makeMockQueryClient();
    mockResolveLeaseProvider.mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'Lease "lease-1" not found on chain'),
    );

    await expect(
      updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, '{}'),
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
      updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, '{}'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('closed'),
    });

    expect(mockUpdateLease).not.toHaveBeenCalled();
  });

  it('lets auth errors propagate', async () => {
    const qc = makeMockQueryClient();
    const authError = new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
      'signArbitrary not supported',
    );
    const failingGetAuthToken = vi.fn().mockRejectedValue(authError);

    await expect(
      updateApp(qc, ADDRESS, 'lease-1', failingGetAuthToken, '{}'),
    ).rejects.toBe(authError);
  });
});
