import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types';
import { resolveLeaseProvider, resolveProviderUrl } from './resolveLeaseProvider.js';
import { makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPErrorCode } from '../types.js';

describe('resolveProviderUrl', () => {
  it('returns the API URL for a valid provider UUID', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'https://provider.example.com' } },
        },
      },
    });

    const url = await resolveProviderUrl(qc, 'prov-1');
    expect(url).toBe('https://provider.example.com');
  });

  it('throws QUERY_FAILED when provider has no API URL', async () => {
    const qc = makeMockQueryClient({
      sku: {
        providerLookup: {
          'prov-bad': { provider: { apiUrl: '' } },
        },
      },
    });

    await expect(
      resolveProviderUrl(qc, 'prov-bad'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('no API URL'),
    });
  });

  it('throws when provider not found', async () => {
    const qc = makeMockQueryClient();

    await expect(
      resolveProviderUrl(qc, 'nonexistent'),
    ).rejects.toThrow();
  });
});

describe('resolveLeaseProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves provider URL from lease UUID via chain queries', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
          createdAt: new Date('2025-01-01'),
        },
      },
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'https://provider.example.com' } },
        },
      },
    });

    const result = await resolveLeaseProvider(qc, 'lease-1');

    expect(result).toEqual({
      providerUuid: 'prov-1',
      providerUrl: 'https://provider.example.com',
      leaseState: LeaseState.LEASE_STATE_ACTIVE,
      leaseCreatedAt: '2025-01-01T00:00:00.000Z',
      leaseClosedAt: undefined,
    });
  });

  it('throws QUERY_FAILED when lease not found', async () => {
    const qc = makeMockQueryClient({
      billing: { lease: null },
    });

    await expect(
      resolveLeaseProvider(qc, 'nonexistent'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('not found on chain'),
    });
  });

  it('throws QUERY_FAILED when lease has no provider UUID', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: '' },
      },
    });

    await expect(
      resolveLeaseProvider(qc, 'lease-1'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('no provider UUID'),
    });
  });

  it('throws QUERY_FAILED when provider has no API URL', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: 'lease-1', state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-bad' },
      },
      sku: {
        providerLookup: {
          'prov-bad': { provider: { apiUrl: '' } },
        },
      },
    });

    await expect(
      resolveLeaseProvider(qc, 'lease-1'),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('no API URL'),
    });
  });

  it('includes closedAt when lease is closed', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'prov-1',
          createdAt: new Date('2025-01-01'),
          closedAt: new Date('2025-06-01'),
        },
      },
      sku: {
        providerLookup: {
          'prov-1': { provider: { apiUrl: 'https://provider.example.com' } },
        },
      },
    });

    const result = await resolveLeaseProvider(qc, 'lease-1');

    expect(result.leaseClosedAt).toBe('2025-06-01T00:00:00.000Z');
  });
});
