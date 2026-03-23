import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/fred.js', () => ({
  getLeaseLogs: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { getLeaseLogs } from '../http/fred.js';
import { getAppLogs } from './getLogs.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

const mockGetLeaseLogs = vi.mocked(getLeaseLogs);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

describe('getAppLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
  });

  it('returns logs from provider', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });
    mockGetLeaseLogs.mockResolvedValue({
      lease_uuid: LEASE_UUID,
      tenant: 'manifest1abc',
      provider_uuid: 'prov-1',
      logs: { web: 'line1\nline2' },
    });

    const result = await getAppLogs(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.lease_uuid).toBe(LEASE_UUID);
    expect(result.logs).toEqual({ web: 'line1\nline2' });
    expect(result.truncated).toBe(false);
  });

  it('truncates logs exceeding MAX_LOG_CHARS', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const longLog = 'x'.repeat(5000);
    mockGetLeaseLogs.mockResolvedValue({
      lease_uuid: LEASE_UUID,
      tenant: 'manifest1abc',
      provider_uuid: 'prov-1',
      logs: { web: longLog },
    });

    const result = await getAppLogs(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.truncated).toBe(true);
    expect(result.logs.web.length).toBe(4000);
  });

  it('skips services when total chars exceeded', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    mockGetLeaseLogs.mockResolvedValue({
      lease_uuid: LEASE_UUID,
      tenant: 'manifest1abc',
      provider_uuid: 'prov-1',
      logs: {
        web: 'x'.repeat(4000),
        worker: 'should be skipped',
      },
    });

    const result = await getAppLogs(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.truncated).toBe(true);
    expect(result.logs.web).toBeDefined();
    expect(result.logs.worker).toBeUndefined();
  });

  it('throws when lease is not active', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
        },
      },
    });

    await expect(
      getAppLogs(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken),
    ).rejects.toThrow('logs are not available');
  });

  it('passes tail parameter to getLeaseLogs', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });
    mockGetLeaseLogs.mockResolvedValue({
      lease_uuid: LEASE_UUID,
      tenant: 'manifest1abc',
      provider_uuid: 'prov-1',
      logs: {},
    });

    await getAppLogs(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken, 50);

    expect(mockGetLeaseLogs).toHaveBeenCalledWith(
      'https://provider.example.com',
      LEASE_UUID,
      'auth-token',
      50,
      undefined,
    );
  });
});
