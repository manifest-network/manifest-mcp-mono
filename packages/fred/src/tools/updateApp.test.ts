import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';

vi.mock('../http/fred.js', () => ({
  updateLease: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { updateApp } from './updateApp.js';
import { updateLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';

const mockUpdateLease = vi.mocked(updateLease);
const mockResolveProviderUrl = vi.mocked(resolveProviderUrl);

const LEASE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token');

describe('updateApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProviderUrl.mockResolvedValue('https://provider.example.com');
    mockUpdateLease.mockResolvedValue({ status: 'updated' });
  });

  it('without existingManifest: full replacement', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: LEASE_UUID, state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });

    const manifest = JSON.stringify({ image: 'nginx:2', ports: { '80/tcp': {} } });
    await updateApp(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken, manifest);

    // Should pass manifest through unchanged
    expect(mockUpdateLease).toHaveBeenCalledWith(
      'https://provider.example.com',
      LEASE_UUID,
      manifest,
      'auth-token',
      undefined,
    );
  });

  it('with existingManifest: env merged, ports merged, fields carried forward', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: { uuid: LEASE_UUID, state: LeaseState.LEASE_STATE_ACTIVE, providerUuid: 'prov-1' },
      },
    });

    const newManifest = JSON.stringify({ image: 'nginx:2', env: { NEW: 'val' } });
    const existingManifest = JSON.stringify({
      image: 'nginx:1',
      ports: { '80/tcp': {} },
      env: { OLD: 'kept', NEW: 'overridden' },
      user: '1000:1000',
    });

    await updateApp(qc, 'manifest1abc', LEASE_UUID, mockGetAuthToken, newManifest, existingManifest);

    const sentManifest = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(sentManifest.image).toBe('nginx:2');
    expect(sentManifest.env).toEqual({ OLD: 'kept', NEW: 'val' });
    expect(sentManifest.ports).toEqual({ '80/tcp': {} });
    expect(sentManifest.user).toBe('1000:1000');
  });
});
