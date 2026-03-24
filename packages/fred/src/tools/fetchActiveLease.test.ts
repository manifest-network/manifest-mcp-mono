import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { describe, expect, it } from 'vitest';
import { fetchActiveLease } from './fetchActiveLease.js';

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('fetchActiveLease', () => {
  it('returns lease when active', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const lease = await fetchActiveLease(qc, LEASE_UUID, 'test action');
    expect(lease.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
  });

  it('returns lease when pending', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_PENDING,
          providerUuid: 'prov-1',
        },
      },
    });

    const lease = await fetchActiveLease(qc, LEASE_UUID, 'test action');
    expect(lease.state).toBe(LeaseState.LEASE_STATE_PENDING);
  });

  it('throws when lease is not found', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });

    await expect(
      fetchActiveLease(qc, LEASE_UUID, 'test action'),
    ).rejects.toThrow(`Lease "${LEASE_UUID}" not found on chain`);
  });

  it('throws when lease is closed', async () => {
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
      fetchActiveLease(qc, LEASE_UUID, 'cannot be restarted'),
    ).rejects.toThrow('cannot be restarted');
  });
});
