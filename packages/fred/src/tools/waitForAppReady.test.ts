import {
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/fred.js', () => ({
  pollLeaseUntilReady: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { pollLeaseUntilReady } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { waitForAppReady } from './waitForAppReady.js';

const mockPoll = vi.mocked(pollLeaseUntilReady);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

function makeActiveQc() {
  return makeMockQueryClient({
    billing: {
      lease: {
        uuid: LEASE_UUID,
        state: LeaseState.LEASE_STATE_ACTIVE,
        providerUuid: 'prov-1',
      },
    },
  });
}

describe('waitForAppReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockPoll.mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
      provision_status: 'provisioned',
    });
  });

  it('returns identifiers + ACTIVE state when poll resolves', async () => {
    const qc = makeActiveQc();
    const result = await waitForAppReady(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.lease_uuid).toBe(LEASE_UUID);
    expect(result.provider_uuid).toBe('prov-1');
    expect(result.provider_url).toBe('https://provider.example.com');
    expect(result.state).toBe('LEASE_STATE_ACTIVE');
    expect(result.status.provision_status).toBe('provisioned');

    expect(mockResolveProviderUrl).toHaveBeenCalledWith(qc, 'prov-1');
    expect(mockPoll).toHaveBeenCalledOnce();
    const [, leaseUuid, , pollOpts] = mockPoll.mock.calls[0];
    expect(leaseUuid).toBe(LEASE_UUID);
    // No options passed → defaults left to pollLeaseUntilReady itself.
    expect(pollOpts).toMatchObject({ intervalMs: undefined });
  });

  it('forwards interval/timeout/abortSignal/onProgress to the poller', async () => {
    const qc = makeActiveQc();
    const onProgress = vi.fn();
    const ac = new AbortController();

    await waitForAppReady(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken, {
      intervalMs: 1500,
      timeoutMs: 60_000,
      onProgress,
      abortSignal: ac.signal,
    });

    expect(mockPoll).toHaveBeenCalledOnce();
    const [, , , pollOpts] = mockPoll.mock.calls[0];
    expect(pollOpts).toMatchObject({
      intervalMs: 1500,
      timeoutMs: 60_000,
      abortSignal: ac.signal,
      onProgress,
    });
  });

  it('rejects when the lease is not active/pending on chain', async () => {
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
      waitForAppReady(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('propagates lease-not-found errors from chain', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });

    await expect(
      waitForAppReady(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken),
    ).rejects.toBeInstanceOf(ManifestMCPError);
    expect(mockResolveProviderUrl).not.toHaveBeenCalled();
    expect(mockPoll).not.toHaveBeenCalled();
  });
});
