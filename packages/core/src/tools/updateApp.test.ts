import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../http/fred.js', () => ({
  updateLease: vi.fn(),
}));

import { updateApp } from './updateApp.js';
import { updateLease } from '../http/fred.js';
import { InMemoryAppRegistry } from '../registry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const mockUpdateLease = vi.mocked(updateLease);

const ADDRESS = 'manifest1user';
const mockGetAuthToken = vi.fn().mockResolvedValue('auth-token-123');

describe('updateApp', () => {
  let registry: InMemoryAppRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new InMemoryAppRegistry();
  });

  it('updates the lease with new image', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
      manifest: JSON.stringify({ image: 'nginx:alpine', ports: { '80/tcp': {} } }),
    });

    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    const result = await updateApp(ADDRESS, 'my-app', registry, mockGetAuthToken, {
      image: 'nginx:latest',
    });

    expect(result).toEqual({ app_name: 'my-app', status: 'updated' });

    const callPayload = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(callPayload.image).toBe('nginx:latest');
    expect(callPayload.ports).toEqual({ '80/tcp': {} });
  });

  it('updates the lease with new env', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
      manifest: JSON.stringify({ image: 'nginx:alpine', ports: { '80/tcp': {} } }),
    });

    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    await updateApp(ADDRESS, 'my-app', registry, mockGetAuthToken, {
      env: { FOO: 'bar' },
    });

    const callPayload = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(callPayload.env).toEqual({ FOO: 'bar' });
    expect(callPayload.image).toBe('nginx:alpine');
  });

  it('updates the lease with new port', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
      manifest: JSON.stringify({ image: 'nginx:alpine', ports: { '80/tcp': {} } }),
    });

    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    await updateApp(ADDRESS, 'my-app', registry, mockGetAuthToken, {
      port: 8080,
    });

    const callPayload = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(callPayload.ports).toEqual({ '8080/tcp': {} });
  });

  it('starts fresh when existing manifest is invalid JSON', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
      manifest: 'not-json',
    });

    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    await updateApp(ADDRESS, 'my-app', registry, mockGetAuthToken, {
      image: 'redis:7',
    });

    const callPayload = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(callPayload.image).toBe('redis:7');
  });

  it('starts fresh when no existing manifest', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    await updateApp(ADDRESS, 'my-app', registry, mockGetAuthToken, {
      image: 'redis:7',
    });

    const callPayload = JSON.parse(mockUpdateLease.mock.calls[0][2]);
    expect(callPayload.image).toBe('redis:7');
  });

  it('updates registry manifest after successful update', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      providerUrl: 'https://provider.example.com',
      status: 'active',
    });

    mockUpdateLease.mockResolvedValue({ status: 'updated' });

    await updateApp(ADDRESS, 'my-app', registry, mockGetAuthToken, {
      image: 'redis:7',
    });

    const app = registry.getApp(ADDRESS, 'my-app');
    const manifest = JSON.parse(app.manifest!);
    expect(manifest.image).toBe('redis:7');
  });

  it('throws QUERY_FAILED when app has no providerUrl', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      status: 'active',
    });

    await expect(
      updateApp(ADDRESS, 'my-app', registry, mockGetAuthToken, { image: 'x' }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('no provider URL'),
    });
  });

  it('throws when app not found in registry', async () => {
    await expect(
      updateApp(ADDRESS, 'nonexistent', registry, mockGetAuthToken, { image: 'x' }),
    ).rejects.toThrow(ManifestMCPError);
  });
});
