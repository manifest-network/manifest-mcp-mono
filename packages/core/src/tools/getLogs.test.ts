import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';

vi.mock('../http/fred.js', () => ({
  getLeaseLogs: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { getAppLogs } from './getLogs.js';
import { getLeaseLogs } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPErrorCode } from '../types.js';

const mockGetLeaseLogs = vi.mocked(getLeaseLogs);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('getAppLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
  });

  it('returns logs for a lease', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockGetLeaseLogs.mockResolvedValue({
      logs: { web: 'line1\nline2', worker: 'log data' },
    });

    const result = await getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(mockResolveProviderUrl).toHaveBeenCalledWith(qc, 'prov-1');
    expect(result.lease_uuid).toBe('lease-1');
    expect(result.logs).toEqual({ web: 'line1\nline2', worker: 'log data' });
    expect(result.truncated).toBe(false);
  });

  it('throws when lease not found on chain', async () => {
    const qc = makeMockQueryClient({
      billing: { lease: null },
    });

    await expect(
      getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
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
      getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockGetLeaseLogs).not.toHaveBeenCalled();
  });

  it('throws when lease is rejected without resolving provider', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_REJECTED, providerUuid: 'prov-1' },
      },
    });

    await expect(
      getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockGetLeaseLogs).not.toHaveBeenCalled();
  });

  it('throws when lease is expired without resolving provider', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_EXPIRED, providerUuid: 'prov-1' },
      },
    });

    await expect(
      getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not active'),
    });

    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockGetLeaseLogs).not.toHaveBeenCalled();
  });

  it('truncates logs to 4000 characters total across services', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockGetLeaseLogs.mockResolvedValue({
      logs: {
        svc1: 'a'.repeat(3000),
        svc2: 'b'.repeat(2000),
      },
    });

    const result = await getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    const totalChars = Object.values(result.logs).reduce((sum, l) => sum + l.length, 0);
    expect(totalChars).toBeLessThanOrEqual(4000);
    expect(result.truncated).toBe(true);
  });

  it('truncates within a single service (takes tail of string)', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    const logData = 'START' + 'x'.repeat(4990) + 'END!!';
    mockGetLeaseLogs.mockResolvedValue({
      logs: { web: logData },
    });

    const result = await getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(result.logs.web).toHaveLength(4000);
    expect(result.logs.web.endsWith('END!!')).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('does not truncate when logs fit within limit', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockGetLeaseLogs.mockResolvedValue({
      logs: { web: 'short log' },
    });

    const result = await getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken);
    expect(result.truncated).toBe(false);
    expect(result.logs.web).toBe('short log');
  });

  it('passes tail parameter to getLeaseLogs', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockGetLeaseLogs.mockResolvedValue({ logs: {} });

    await getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken, 100);

    expect(mockGetLeaseLogs).toHaveBeenCalledWith(
      'https://provider.example.com',
      'lease-1',
      'auth-token-123',
      100,
    );
  });

  it('skips services when total character limit reached', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });
    mockGetLeaseLogs.mockResolvedValue({
      logs: {
        svc1: 'a'.repeat(4000),
        svc2: 'b'.repeat(1000),
      },
    });

    const result = await getAppLogs(qc, ADDRESS, 'lease-1', mockGetAuthToken);

    expect(result.logs.svc1).toHaveLength(4000);
    expect(result.logs.svc2).toBeUndefined();
    expect(result.truncated).toBe(true);
  });
});
