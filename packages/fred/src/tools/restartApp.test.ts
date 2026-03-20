import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/fred.js', () => ({
  restartLease: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { restartLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { restartApp } from './restartApp.js';

const mockRestartLease = vi.mocked(restartLease);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

describe('restartApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockRestartLease.mockResolvedValue({ status: 'restarting' });
  });

  it('restarts an active lease and returns status', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await restartApp(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result).toEqual({
      lease_uuid: LEASE_UUID,
      status: 'restarting',
    });
    expect(mockRestartLease).toHaveBeenCalledWith(
      'https://provider.example.com',
      LEASE_UUID,
      'auth-token',
      undefined,
    );
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
      restartApp(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken),
    ).rejects.toThrow('cannot be restarted');
  });
});
