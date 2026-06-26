import { LeaseState, noopLogger } from '@manifest-network/manifest-mcp-core';
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
const fetchSpy = vi.fn(globalThis.fetch);

function makeCtx(qc: ReturnType<typeof makeMockQueryClient>) {
  return {
    query: qc,
    chain: {} as never,
    fetch: fetchSpy,
    logger: noopLogger,
    providerAuth: {
      providerToken: (i: { address: string; leaseUuid: string }) =>
        mockGetAuthToken(i.address, i.leaseUuid),
      leaseDataToken: vi.fn(),
    },
  };
}

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

    const result = await restartApp(makeCtx(qc), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result).toEqual({
      lease_uuid: LEASE_UUID,
      status: 'restarting',
    });
    expect(mockRestartLease).toHaveBeenCalledWith(
      'https://provider.example.com',
      LEASE_UUID,
      'auth-token',
      fetchSpy,
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
      restartApp(makeCtx(qc), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toThrow('cannot be restarted');
  });
});
