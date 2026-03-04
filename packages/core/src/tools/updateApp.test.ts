import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';

vi.mock('../http/fred.js', () => ({
  updateLease: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { updateApp } from './updateApp.js';
import { updateLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const mockUpdateLease = vi.mocked(updateLease);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('updateApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
  });

  it('queries lease, resolves provider URL, and updates the lease', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    const manifest = JSON.stringify({ image: 'nginx:latest', ports: { '80/tcp': {} } });
    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    const result = await updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, manifest);

    expect(mockResolveProviderUrl).toHaveBeenCalledWith(qc, 'prov-1');
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
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    const manifest = '{"image":"redis:7","ports":{"6379/tcp":{}},"env":{"FOO":"bar"}}';
    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    await updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, manifest);

    expect(mockUpdateLease.mock.calls[0][2]).toBe(manifest);
  });

  it('throws when lease not found on chain', async () => {
    const qc = makeMockQueryClient({
      billing: { lease: null },
    });

    await expect(
      updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, '{}'),
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
      updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, '{}'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockUpdateLease).not.toHaveBeenCalled();
  });

  it('throws when lease is rejected without resolving provider', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_REJECTED, providerUuid: 'prov-1' },
      },
    });

    await expect(
      updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, '{}'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockUpdateLease).not.toHaveBeenCalled();
  });

  it('throws when lease is expired without resolving provider', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_EXPIRED, providerUuid: 'prov-1' },
      },
    });

    await expect(
      updateApp(qc, ADDRESS, 'lease-1', mockGetAuthToken, '{}'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockUpdateLease).not.toHaveBeenCalled();
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
      updateApp(qc, ADDRESS, 'lease-1', failingGetAuthToken, '{}'),
    ).rejects.toBe(authError);
  });
});
