import { LeaseState } from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../http/fred.js', () => ({
  updateLease: vi.fn(),
}));

vi.mock('./resolveLeaseProvider.js', () => ({
  resolveProviderUrl: vi.fn(),
}));

import { ManifestMCPErrorCode } from '@manifest-network/manifest-mcp-core';
import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { updateLease } from '../http/fred.js';
import { resolveProviderUrl } from './resolveLeaseProvider.js';
import { updateApp } from './updateApp.js';

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
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const manifest = JSON.stringify({
      image: 'nginx:2',
      ports: { '80/tcp': {} },
    });
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
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      image: 'nginx:2',
      env: { NEW: 'val' },
    });
    const existingManifest = JSON.stringify({
      image: 'nginx:1',
      ports: { '80/tcp': {} },
      env: { OLD: 'kept', NEW: 'overridden' },
      user: '1000:1000',
    });

    await updateApp(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
      newManifest,
      existingManifest,
    );

    const sentManifest = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(sentManifest.image).toBe('nginx:2');
    expect(sentManifest.env).toEqual({ OLD: 'kept', NEW: 'val' });
    expect(sentManifest.ports).toEqual({ '80/tcp': {} });
    expect(sentManifest.user).toBe('1000:1000');
  });

  it('stack merge: per-service env merged with services wrapper in output', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: {
        web: { image: 'nginx:2', env: { NEW: 'val' } },
        db: { image: 'mysql:9' },
      },
    });
    const existingManifest = JSON.stringify({
      services: {
        web: {
          image: 'nginx:1',
          env: { OLD: 'kept', NEW: 'overridden' },
          ports: { '80/tcp': {} },
        },
        db: { image: 'mysql:8', ports: { '3306/tcp': {} } },
      },
    });

    await updateApp(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
      newManifest,
      existingManifest,
    );

    const sent = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(sent.services).toBeDefined();
    expect(sent.services.web.image).toBe('nginx:2');
    expect(sent.services.web.env).toEqual({ OLD: 'kept', NEW: 'val' });
    expect(sent.services.web.ports).toEqual({ '80/tcp': {} });
    expect(sent.services.db.image).toBe('mysql:9');
    expect(sent.services.db.ports).toEqual({ '3306/tcp': {} });
  });

  it('stack merge: new service gets empty merge base', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: {
        web: { image: 'nginx' },
        cache: { image: 'redis', env: { MAXMEM: '64mb' } },
      },
    });
    const existingManifest = JSON.stringify({
      services: {
        web: { image: 'nginx', env: { OLD: 'val' } },
      },
    });

    await updateApp(
      qc,
      'manifest1abc',
      LEASE_UUID,
      mockGetAuthToken,
      newManifest,
      existingManifest,
    );

    const sent = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(sent.services.cache.image).toBe('redis');
    expect(sent.services.cache.env).toEqual({ MAXMEM: '64mb' });
  });

  it('throws on invalid manifest JSON when existingManifest is provided', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    await expect(
      updateApp(
        qc,
        'manifest1abc',
        LEASE_UUID,
        mockGetAuthToken,
        'not-valid-json',
        '{"image":"nginx"}',
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid manifest JSON'),
    });
  });

  it('stack merge: throws on unparseable existingManifest JSON', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: { web: { image: 'nginx' } },
    });

    await expect(
      updateApp(
        qc,
        'manifest1abc',
        LEASE_UUID,
        mockGetAuthToken,
        newManifest,
        'not-valid-json',
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid existing_manifest'),
    });
  });

  it('stack merge: throws on invalid service name', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: { 'INVALID_NAME!': { image: 'nginx' } },
    });

    await expect(
      updateApp(
        qc,
        'manifest1abc',
        LEASE_UUID,
        mockGetAuthToken,
        newManifest,
        '{"services":{"web":{"image":"old"}}}',
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid service name'),
    });
  });

  it('stack merge: throws when existing_manifest is not a stack', async () => {
    const qc = makeMockQueryClient({
      billing: {
        lease: {
          uuid: LEASE_UUID,
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'prov-1',
        },
      },
    });

    const newManifest = JSON.stringify({
      services: { web: { image: 'nginx' } },
    });
    const existingManifest = JSON.stringify({
      image: 'nginx',
      ports: { '80/tcp': {} },
    });

    await expect(
      updateApp(
        qc,
        'manifest1abc',
        LEASE_UUID,
        mockGetAuthToken,
        newManifest,
        existingManifest,
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Cannot merge'),
    });
  });
});
