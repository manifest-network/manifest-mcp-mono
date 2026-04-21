import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return {
    ...actual,
    cosmosTx: vi.fn(),
  };
});

vi.mock('../http/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/provider.js')>();
  return {
    ...actual,
    uploadLeaseData: vi.fn(),
    getLeaseConnectionInfo: vi.fn(),
  };
});

vi.mock('../http/fred.js', () => ({
  pollLeaseUntilReady: vi.fn(),
}));

import {
  cosmosTx,
  LeaseState,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  makeMockClientManager,
  makeMockQueryClient,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { pollLeaseUntilReady } from '../http/fred.js';
import { getLeaseConnectionInfo, uploadLeaseData } from '../http/provider.js';
import { deployApp } from './deployApp.js';

const mockCosmosTx = vi.mocked(cosmosTx);
const mockUploadLeaseData = vi.mocked(uploadLeaseData);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);
const mockPollLeaseUntilReady = vi.mocked(pollLeaseUntilReady);

const mockGetAuthToken = vi.fn();
const mockGetLeaseDataAuthToken = vi.fn();

function makeQueryClient() {
  return makeMockQueryClient({
    sku: {
      providers: [
        {
          uuid: 'prov-1',
          address: 'manifest1prov',
          apiUrl: 'http://localhost:8080',
          active: true,
        },
      ],
      skus: [
        {
          uuid: 'sku-micro-uuid',
          name: 'docker-micro',
          providerUuid: 'prov-1',
          basePrice: { amount: '36000', denom: 'umfx' },
        },
      ],
      providerLookup: {
        'prov-1': { provider: { apiUrl: 'http://localhost:8080' } } as any,
      },
    },
  });
}

describe('deployApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      transactionHash: 'TX123',
      code: 0,
      height: '100',
      confirmed: true,
      events: [
        {
          type: 'liftedinit.billing.v1.LeaseCreated',
          attributes: [
            {
              key: 'lease_uuid',
              value: '"550e8400-e29b-41d4-a716-446655440000"',
            },
          ],
        },
      ],
    });

    mockGetAuthToken.mockResolvedValue('auth-token');
    mockGetLeaseDataAuthToken.mockResolvedValue('lease-data-token');
    mockUploadLeaseData.mockResolvedValue(undefined);
    mockPollLeaseUntilReady.mockResolvedValue({
      state: LeaseState.LEASE_STATE_ACTIVE,
    });
    mockGetLeaseConnectionInfo.mockResolvedValue({
      lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
      tenant: 'manifest1tenant',
      provider_uuid: 'prov-1',
      connection: {
        host: 'app.localhost',
        ports: { '80/tcp': 32001 },
      },
    });
  });

  it('single-service deploy uses buildManifest', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const result = await deployApp(
      cm as any,
      mockGetAuthToken,
      mockGetLeaseDataAuthToken,
      {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        env: { FOO: 'bar' },
      },
    );

    expect(result.lease_uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    expect(result.url).toBe('app.localhost:32001');
    expect(result.connection).toEqual({
      host: 'app.localhost',
      ports: { '80/tcp': 32001 },
    });

    // Verify manifest is uploaded as Uint8Array with correct content
    const rawPayload = mockUploadLeaseData.mock.calls[0][2];
    expect(rawPayload).toBeInstanceOf(Uint8Array);
    const payload = new TextDecoder().decode(rawPayload);
    const manifest = JSON.parse(payload);
    expect(manifest).toEqual({
      image: 'nginx:alpine',
      ports: { '80/tcp': {} },
      env: { FOO: 'bar' },
    });
    expect(manifest.command).toBeUndefined();
    expect(manifest.user).toBeUndefined();
  });

  it('passes gasMultiplier override to cosmosTx', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
      image: 'nginx:alpine',
      port: 80,
      size: 'docker-micro',
      gasMultiplier: 5.0,
    });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      expect.anything(),
      'billing',
      'create-lease',
      expect.any(Array),
      true,
      { gasMultiplier: 5.0 },
    );
  });

  it('stack deploy with 2 services produces stack manifest', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
      size: 'docker-micro',
      services: {
        web: { image: 'nginx', ports: { '80/tcp': {} } },
        db: {
          image: 'mysql:8',
          ports: { '3306/tcp': {} },
          env: { MYSQL_ROOT_PASSWORD: 'secret' },
        },
      },
    });

    const payload = new TextDecoder().decode(
      mockUploadLeaseData.mock.calls[0][2],
    );
    const manifest = JSON.parse(payload);
    expect(Object.keys(manifest)).toEqual(['services']);
    expect(Object.keys(manifest.services)).toEqual(['web', 'db']);
    expect(manifest.services.web).toEqual({
      image: 'nginx',
      ports: { '80/tcp': {} },
    });
    expect(manifest.services.db).toEqual({
      image: 'mysql:8',
      ports: { '3306/tcp': {} },
      env: { MYSQL_ROOT_PASSWORD: 'secret' },
    });
  });

  it('stack deploy lease items include service names', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
      size: 'docker-micro',
      services: {
        web: { image: 'nginx' },
        db: { image: 'mysql:8' },
      },
    });

    const txArgs = mockCosmosTx.mock.calls[0][3] as string[];
    expect(txArgs).toContain('sku-micro-uuid:1:web');
    expect(txArgs).toContain('sku-micro-uuid:1:db');
    // Should NOT contain bare 'sku-micro-uuid:1'
    expect(txArgs).not.toContain('sku-micro-uuid:1');
  });

  it('throws when both image and services are provided', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc });

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
        image: 'nginx',
        port: 80,
        size: 'docker-micro',
        services: { web: { image: 'nginx' } },
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('mutually exclusive'),
    });
  });

  it('throws when neither image nor services is provided', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc });

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
        size: 'docker-micro',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('either image or services is required'),
    });
  });

  it('throws when image is provided without port', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc });

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
        image: 'nginx',
        size: 'docker-micro',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('port is required'),
    });
  });

  it('throws when chain event returns malformed lease UUID', async () => {
    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      transactionHash: 'TX123',
      code: 0,
      height: '100',
      confirmed: true,
      events: [
        {
          type: 'liftedinit.billing.v1.LeaseCreated',
          attributes: [{ key: 'lease_uuid', value: '"not-a-valid-uuid"' }],
        },
      ],
    });

    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('must be a valid UUID'),
    });
  });

  it.each([
    ['uppercase', 'Web'],
    ['leading hyphen', '-web'],
    ['too long', 'a'.repeat(64)],
  ])('throws on invalid service name: %s', async (_label, name) => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc });

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
        size: 'docker-micro',
        services: { [name]: { image: 'nginx' } },
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_CONFIG,
      message: expect.stringContaining('Invalid service name'),
    });
  });

  it('fires onLeaseCreated once after TX with leaseUuid and providerUrl, before upload/poll', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const order: string[] = [];
    mockUploadLeaseData.mockImplementation(async () => {
      order.push('upload');
    });
    mockPollLeaseUntilReady.mockImplementation(async () => {
      order.push('poll');
      return { state: LeaseState.LEASE_STATE_ACTIVE };
    });

    const onLeaseCreated = vi.fn((_uuid: string, _url: string) => {
      order.push('onLeaseCreated');
    });

    await deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
      image: 'nginx:alpine',
      port: 80,
      size: 'docker-micro',
      onLeaseCreated,
    });

    expect(onLeaseCreated).toHaveBeenCalledTimes(1);
    expect(onLeaseCreated).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      'http://localhost:8080',
    );
    expect(order).toEqual(['onLeaseCreated', 'upload', 'poll']);
  });

  it('surfaces onLeaseCreated errors raw (not wrapped as partial success)', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const onLeaseCreated = vi.fn(() => {
      throw new Error('registry write failed');
    });

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        onLeaseCreated,
      }),
    ).rejects.toThrow(/registry write failed/);

    // Upload and poll never run when the callback throws.
    expect(mockUploadLeaseData).not.toHaveBeenCalled();
    expect(mockPollLeaseUntilReady).not.toHaveBeenCalled();
  });

  it('forwards pollOptions to pollLeaseUntilReady', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    const controller = new AbortController();
    const onProgress = vi.fn();
    const checkChainState = vi.fn().mockResolvedValue(null);

    await deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
      image: 'nginx:alpine',
      port: 80,
      size: 'docker-micro',
      pollOptions: {
        intervalMs: 123,
        timeoutMs: 45_678,
        abortSignal: controller.signal,
        onProgress,
        checkChainState,
      },
    });

    expect(mockPollLeaseUntilReady).toHaveBeenCalledTimes(1);
    const forwarded = mockPollLeaseUntilReady.mock.calls[0][3];
    expect(forwarded).toEqual({
      intervalMs: 123,
      timeoutMs: 45_678,
      abortSignal: controller.signal,
      onProgress,
      checkChainState,
    });
  });

  it('passes undefined pollOptions when not provided (preserves poll defaults)', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });

    await deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, {
      image: 'nginx:alpine',
      port: 80,
      size: 'docker-micro',
    });

    expect(mockPollLeaseUntilReady).toHaveBeenCalledTimes(1);
    expect(mockPollLeaseUntilReady.mock.calls[0][3]).toBeUndefined();
  });
});
