import {
  INFRASTRUCTURE_ERROR_CODES,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
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

describe('appStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockGetLeaseStatus.mockResolvedValue({
      status: 'running',
      services: { web: { ready: true, available: 1, total: 1 } },
    });
    mockGetLeaseConnectionInfo.mockResolvedValue({
      host: 'app.example.com',
      ports: { '80/tcp': 8080 },
    });
  });

  it('returns combined chain state and provider status for active lease', async () => {
    const qc = makeActiveQc();
    const result = await appStatus(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.lease_uuid).toBe(LEASE_UUID);
    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.fredStatus?.status).toBe('running');
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

    const result = await appStatus(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.chainState.state).toBe(LeaseState.LEASE_STATE_CLOSED);
    expect(result.fredStatus).toBeUndefined();
    expect(result.connection).toBeUndefined();
  });

  it('throws when lease not found', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });

    await expect(
      appStatus(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken),
    ).rejects.toThrow('not found on chain');
  });

  it('returns providerError when resolveProviderUrl fails', async () => {
    const qc = makeActiveQc();
    mockResolveProviderUrl.mockRejectedValue(new Error('bad url'));

    const result = await appStatus(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

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
      appStatus(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken),
    ).rejects.toBe(infraErr);
  });

  it('handles partial provider failure with Promise.allSettled', async () => {
    const qc = makeActiveQc();
    mockGetLeaseStatus.mockRejectedValue(new Error('status failed'));
    // connection succeeds

    const result = await appStatus(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.providerError).toBe('status failed');
    expect(result.connection?.host).toBe('app.example.com');
  });

  it('returns providerError when getAuthToken fails', async () => {
    const qc = makeActiveQc();
    mockGetAuthToken.mockRejectedValueOnce(new Error('signing failed'));

    const result = await appStatus(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.providerError).toContain('Auth token error');
    expect(result.fredStatus).toBeUndefined();
  });

  it('returns connectionError when only connection info fails', async () => {
    const qc = makeActiveQc();
    mockGetLeaseConnectionInfo.mockRejectedValue(
      new Error('connection failed'),
    );
    // status succeeds

    const result = await appStatus(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
    );

    expect(result.fredStatus?.status).toBe('running');
    expect(result.connectionError).toBe('connection failed');
  });
});
