import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';

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

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { appStatus } from './appStatus.js';
import { getLeaseStatus } from '../http/fred.js';
import { getLeaseConnectionInfo } from '../http/provider.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const mockGetLeaseStatus = vi.mocked(getLeaseStatus);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('appStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns chain state + fred status + connection info for active lease', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1', createdAt: new Date('2025-01-01') },
      },
    });
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');

    mockGetLeaseStatus.mockResolvedValue({ status: 'running', services: { web: { ready: true, available: 1, total: 1 } } });
    mockGetLeaseConnectionInfo.mockResolvedValue({ host: '1.2.3.4', ports: { http: 8080 } });

    const result = await appStatus(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(mockResolveProviderUrl).toHaveBeenCalledWith(qc, 'prov-1');
    expect(result.lease_uuid).toBe('lease-1');
    expect(result.chainState).toEqual({
      state: LeaseState.LEASE_STATE_ACTIVE,
      providerUuid: 'prov-1',
      createdAt: '2025-01-01T00:00:00.000Z',
      closedAt: undefined,
    });
    expect(result.fredStatus).toEqual({ status: 'running', services: { web: { ready: true, available: 1, total: 1 } } });
    expect(result.connection).toEqual({ host: '1.2.3.4', ports: { http: 8080 } });
  });

  it.each([
    LeaseState.LEASE_STATE_CLOSED,
    LeaseState.LEASE_STATE_REJECTED,
    LeaseState.LEASE_STATE_EXPIRED,
  ])('skips fred calls and provider resolution for non-operational lease state %i', async (state) => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state, providerUuid: 'prov-1' },
      },
    });

    const result = await appStatus(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(result.chainState.state).toBe(state);
    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockGetLeaseStatus).not.toHaveBeenCalled();
    expect(mockGetLeaseConnectionInfo).not.toHaveBeenCalled();
  });

  it('makes fred calls for pending (state=1) leases', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_PENDING, providerUuid: 'prov-1' },
      },
    });
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');

    mockGetLeaseStatus.mockResolvedValue({ status: 'provisioning' });
    mockGetLeaseConnectionInfo.mockResolvedValue({ host: '1.2.3.4', ports: {} });

    await appStatus(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(mockGetLeaseStatus).toHaveBeenCalledOnce();
    expect(mockGetLeaseConnectionInfo).toHaveBeenCalledOnce();
  });

  it('captures providerError when fred status call fails', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');

    mockGetLeaseStatus.mockRejectedValue(new Error('provider down'));
    mockGetLeaseConnectionInfo.mockResolvedValue({ host: '1.2.3.4', ports: {} });

    const result = await appStatus(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(result.providerError).toBe('provider down');
    expect(result.fredStatus).toBeUndefined();
    expect(result.connection).toEqual({ host: '1.2.3.4', ports: {} });
  });

  it('captures connectionError when connection info call fails', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');

    mockGetLeaseStatus.mockResolvedValue({ status: 'running' });
    mockGetLeaseConnectionInfo.mockRejectedValue(new Error('connection refused'));

    const result = await appStatus(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(result.fredStatus).toEqual({ status: 'running' });
    expect(result.connectionError).toBe('connection refused');
    expect(result.connection).toBeUndefined();
  });

  it('returns chain state with providerError when auth token fails', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');

    const failingGetAuthToken = vi.fn().mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.WALLET_NOT_CONNECTED, 'signArbitrary not supported'),
    );

    const result = await appStatus(qc, ADDRESS, 'lease-1', failingGetAuthToken);

    expect(result.lease_uuid).toBe('lease-1');
    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.providerError).toContain('signArbitrary not supported');
    expect(result.fredStatus).toBeUndefined();
    expect(result.connection).toBeUndefined();
  });

  it('returns chain state with providerError when provider resolution fails', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockResolveProviderUrl.mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'Provider "prov-1" has no API URL'),
    );

    const result = await appStatus(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(result.lease_uuid).toBe('lease-1');
    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.providerError).toContain('Provider "prov-1" has no API URL');
    expect(result.fredStatus).toBeUndefined();
    expect(result.connection).toBeUndefined();
  });

  it('throws when lease not found on chain', async () => {
    const qc = makeMockQueryClient({
      billing: { lease: null },
    });

    await expect(
      appStatus(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not found on chain'),
    });
  });
});
