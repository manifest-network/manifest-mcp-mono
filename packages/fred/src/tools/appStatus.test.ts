import {
  INFRASTRUCTURE_ERROR_CODES,
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
  noopLogger,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/fred.js', () => ({
  getLeaseStatus: vi.fn(),
}));

vi.mock('../http/provider.js', () => ({
  getLeaseConnectionInfo: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { getLeaseStatus } from '../http/fred.js';
import { getLeaseConnectionInfo } from '../http/provider.js';
import { appStatus } from './appStatus.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';

const mockGetLeaseStatus = vi.mocked(getLeaseStatus);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');
const fetchSpy = vi.fn(globalThis.fetch);

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

// Build a FredAuthCtx whose providerAuth.providerToken delegates to the
// supplied `getAuthToken` thunk (so the existing token-flow assertions hold).
function makeCtx(
  qc: ReturnType<typeof makeMockQueryClient>,
  getAuthToken: (address: string, leaseUuid: string) => Promise<string>,
) {
  return {
    query: qc,
    chain: {} as never,
    fetch: fetchSpy,
    logger: noopLogger,
    providerAuth: {
      providerToken: (i: { address: string; leaseUuid: string }) =>
        getAuthToken(i.address, i.leaseUuid),
      leaseDataToken: vi.fn(),
    },
  };
}

describe('appStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockGetLeaseStatus.mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
      services: { web: { instances: [{ name: 'web-0', status: 'running' }] } },
    });
    mockGetLeaseConnectionInfo.mockResolvedValue({
      lease_uuid: LEASE_UUID,
      tenant: 'manifest1abc',
      provider_uuid: 'prov-1',
      connection: {
        host: 'app.example.com',
        ports: { '80/tcp': 8080 },
      },
    });
  });

  it('returns combined chain state and provider status for active lease', async () => {
    const qc = makeActiveQc();
    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.lease_uuid).toBe(LEASE_UUID);
    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.fredStatus?.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.connection?.host).toBe('app.example.com');
  });

  it('returns only chain state for closed lease', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(result.fredStatus).toBeUndefined();
    expect(result.connection).toBeUndefined();
  });

  it('includes lease.items in chainState (so consumers skip a second getLease)', async () => {
    const items = [
      {
        skuUuid: 'sku-1',
        quantity: 1n,
        lockedPrice: { denom: 'upwr', amount: '100' },
        serviceName: 'web',
        customDomain: 'app.example.com',
      },
    ];
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
          items,
        },
      },
    });

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.chainState.items).toEqual(items);
  });

  it('throws when lease not found', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });

    await expect(
      appStatus(makeCtx(qc, mockGetAuthToken), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toThrow('not found on chain');
  });

  it('returns providerError when resolveProviderUrl fails', async () => {
    const qc = makeActiveQc();
    mockResolveProviderUrl.mockRejectedValue(new Error('bad url'));

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.providerError).toContain('Could not resolve provider');
    expect(result.fredStatus).toBeUndefined();
  });

  it('re-throws infrastructure errors from resolveProviderUrl', async () => {
    const qc = makeActiveQc();
    const infraErr = new ManifestMCPError(
      ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
      'rpc down',
    );
    expect(INFRASTRUCTURE_ERROR_CODES.has(infraErr.code)).toBe(true);
    mockResolveProviderUrl.mockRejectedValue(infraErr);

    await expect(
      appStatus(makeCtx(qc, mockGetAuthToken), {
        address: 'manifest1abc',
        leaseUuid: LEASE_UUID,
      }),
    ).rejects.toBe(infraErr);
  });

  it('handles partial provider failure with Promise.allSettled', async () => {
    const qc = makeActiveQc();
    mockGetLeaseStatus.mockRejectedValue(new Error('status failed'));
    // connection succeeds

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.providerError).toBe('status failed');
    expect(result.connection?.host).toBe('app.example.com');
  });

  it('returns providerError when getAuthToken fails', async () => {
    const qc = makeActiveQc();
    mockGetAuthToken.mockRejectedValueOnce(new Error('signing failed'));

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.providerError).toContain('Auth token error');
    expect(result.fredStatus).toBeUndefined();
  });

  it('calls getAuthToken twice with distinct tokens for status and connection', async () => {
    const qc = makeActiveQc();
    const distinctTokenFn = vi
      .fn()
      .mockResolvedValueOnce('status-token')
      .mockResolvedValueOnce('conn-token');

    await appStatus(makeCtx(qc, distinctTokenFn), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(distinctTokenFn).toHaveBeenCalledTimes(2);
    expect(mockGetLeaseStatus).toHaveBeenCalledWith(
      expect.any(String),
      LEASE_UUID,
      'status-token',
      fetchSpy,
    );
    expect(mockGetLeaseConnectionInfo).toHaveBeenCalledWith(
      expect.any(String),
      LEASE_UUID,
      'conn-token',
      fetchSpy,
    );
  });

  it('returns connectionError when only connection info fails', async () => {
    const qc = makeActiveQc();
    mockGetLeaseConnectionInfo.mockRejectedValue(
      new Error('connection failed'),
    );
    // status succeeds

    const result = await appStatus(makeCtx(qc, mockGetAuthToken), {
      address: 'manifest1abc',
      leaseUuid: LEASE_UUID,
    });

    expect(result.fredStatus?.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.connectionError).toBe('connection failed');
  });
});
