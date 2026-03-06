import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

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

import { deployApp, type DeployAppInput } from './deployApp.js';
import { cosmosTx } from '../cosmos.js';
import { uploadLeaseData, getLeaseConnectionInfo } from '../http/provider.js';
import { pollLeaseUntilReady } from '../http/fred.js';
import { makeMockClientManager, makeMockQueryClient } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

const mockCosmosTx = vi.mocked(cosmosTx);
const mockUploadLeaseData = vi.mocked(uploadLeaseData);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);
const mockPollLeaseUntilReady = vi.mocked(pollLeaseUntilReady);

const mockGetAuthToken = vi.fn();
const mockGetLeaseDataAuthToken = vi.fn();

function makeQueryClient(extraSkus?: { uuid: string; name: string; providerUuid: string; basePrice: { amount: string; denom: string } }[]) {
  return makeMockQueryClient({
    sku: {
      providers: [
        { uuid: 'prov-1', address: 'manifest1prov', apiUrl: 'http://localhost:8080', active: true },
      ],
      skus: [
        { uuid: 'sku-micro-uuid', name: 'docker-micro', providerUuid: 'prov-1', basePrice: { amount: '36000', denom: 'umfx' } },
        ...(extraSkus ?? []),
      ],
      providerLookup: {
        'prov-1': { provider: { apiUrl: 'http://localhost:8080' } } as any,
      },
    },
  });
}

const DEFAULT_INPUT: DeployAppInput = {
  image: 'nginx:alpine',
  port: 80,
  size: 'docker-micro',
};

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
            { key: 'lease_uuid', value: '"lease-uuid-1"' },
          ],
        },
      ],
    });

    mockGetAuthToken.mockResolvedValue('auth-token');
    mockGetLeaseDataAuthToken.mockResolvedValue('lease-data-token');
    mockUploadLeaseData.mockResolvedValue(undefined);
    mockPollLeaseUntilReady.mockResolvedValue({ status: 'running' });
    mockGetLeaseConnectionInfo.mockResolvedValue({
      host: 'app.localhost',
      ports: { '80/tcp': 32001 },
    });
  });

  it('deploys an app through the full lifecycle', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    const result = await deployApp(
      cm as any,
      mockGetAuthToken,
      mockGetLeaseDataAuthToken,
      DEFAULT_INPUT,
    );

    expect(result.lease_uuid).toBe('lease-uuid-1');
    expect(result.provider_uuid).toBe('prov-1');
    expect(result.provider_url).toBe('http://localhost:8080');
    expect(result.status).toBe('running');

    expect(mockCosmosTx).toHaveBeenCalledOnce();
    const txArgs = mockCosmosTx.mock.calls[0];
    expect(txArgs[1]).toBe('billing');
    expect(txArgs[2]).toBe('create-lease');
    expect(txArgs[3]).toContain('--meta-hash');

    expect(mockUploadLeaseData).toHaveBeenCalledOnce();
    expect(mockUploadLeaseData.mock.calls[0][3]).toBe('lease-data-token');

    expect(mockPollLeaseUntilReady).toHaveBeenCalledOnce();
  });

  it('includes env in manifest when provided', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    await deployApp(
      cm as any,
      mockGetAuthToken,
      mockGetLeaseDataAuthToken,
      { ...DEFAULT_INPUT, env: { FOO: 'bar' } },
    );

    const payload = mockUploadLeaseData.mock.calls[0][2];
    const manifest = JSON.parse(payload);
    expect(manifest.env).toEqual({ FOO: 'bar' });
  });

  it('throws when SKU tier not found', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    await expect(
      deployApp(
        cm as any,
        mockGetAuthToken,
        mockGetLeaseDataAuthToken,
        { ...DEFAULT_INPUT, size: 'nonexistent-tier' },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('nonexistent-tier'),
    });
  });

  it('throws when create-lease tx fails with nonzero code', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'Transaction billing create-lease failed with code 5: insufficient funds',
      ),
    );

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, DEFAULT_INPUT),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
    });
  });

  it('throws when lease UUID cannot be extracted from events', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      transactionHash: 'TX123',
      code: 0,
      height: '100',
      events: [{ type: 'other.event', attributes: [{ key: 'foo', value: 'bar' }] }],
    });

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, DEFAULT_INPUT),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('lease UUID'),
    });
  });

  it('throws when no events in tx result', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'create-lease',
      transactionHash: 'TX123',
      code: 0,
      height: '100',
    });

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, DEFAULT_INPUT),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('No events'),
    });
  });

  it('throws with lease UUID in details when upload fails after lease creation', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    mockUploadLeaseData.mockRejectedValue(new Error('upload timeout'));

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, DEFAULT_INPUT),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('lease lease-uuid-1 was created'),
      details: expect.objectContaining({ lease_uuid: 'lease-uuid-1' }),
    });
  });

  it('throws with lease UUID in details when polling fails after upload', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    mockPollLeaseUntilReady.mockRejectedValue(new Error('timed out'));

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, DEFAULT_INPUT),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('lease lease-uuid-1 was created'),
      details: expect.objectContaining({ lease_uuid: 'lease-uuid-1' }),
    });
  });

  it('preserves original error code when ManifestMCPError thrown after lease creation', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    mockGetLeaseDataAuthToken.mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.WALLET_NOT_CONNECTED, 'signArbitrary not supported'),
    );

    await expect(
      deployApp(cm as any, mockGetAuthToken, mockGetLeaseDataAuthToken, DEFAULT_INPUT),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
      message: expect.stringContaining('lease lease-uuid-1 was created'),
      details: expect.objectContaining({ lease_uuid: 'lease-uuid-1' }),
    });
  });

  it('handles connection info failure gracefully', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    mockGetLeaseConnectionInfo.mockRejectedValue(new Error('connection refused'));

    const result = await deployApp(
      cm as any,
      mockGetAuthToken,
      mockGetLeaseDataAuthToken,
      DEFAULT_INPUT,
    );

    expect(result.status).toBe('running');
    expect(result.url).toBeUndefined();
    expect(result.connection).toBeUndefined();
    expect(result.connectionError).toBe('connection refused');
  });

  it.each([
    ['command', { command: ['/bin/sh', '-c', 'echo hello'] }],
    ['args', { args: ['--config', '/etc/app.conf'] }],
    ['user', { user: '1000:1000' }],
    ['tmpfs', { tmpfs: ['/tmp:size=64M'] }],
    ['health_check', { health_check: { test: ['CMD', 'curl', '-f', 'http://localhost/'], interval: '30s', retries: 3 } }],
    ['stop_grace_period', { stop_grace_period: '30s' }],
    ['init', { init: true }],
    ['expose', { expose: ['8080/tcp'] }],
    ['labels', { labels: { app: 'test', tier: 'web' } }],
    ['depends_on', { depends_on: { db: { condition: 'service_healthy' } } }],
  ])('includes %s in manifest when provided', async (_field, extra) => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    await deployApp(
      cm as any,
      mockGetAuthToken,
      mockGetLeaseDataAuthToken,
      { ...DEFAULT_INPUT, ...extra },
    );

    const payload = mockUploadLeaseData.mock.calls[0][2];
    const manifest = JSON.parse(payload);
    const key = Object.keys(extra)[0];
    expect(manifest[key]).toEqual(Object.values(extra)[0]);
  });

  it('includes init=false in manifest when explicitly set', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    await deployApp(
      cm as any,
      mockGetAuthToken,
      mockGetLeaseDataAuthToken,
      { ...DEFAULT_INPUT, init: false },
    );

    const payload = mockUploadLeaseData.mock.calls[0][2];
    const manifest = JSON.parse(payload);
    expect(manifest.init).toBe(false);
  });

  it('adds storage SKU as second lease item when storage is provided', async () => {
    const qc = makeQueryClient([
      { uuid: 'sku-storage-uuid', name: 'docker-small-storage', providerUuid: 'prov-1', basePrice: { amount: '10000', denom: 'umfx' } },
    ]);
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    await deployApp(
      cm as any,
      mockGetAuthToken,
      mockGetLeaseDataAuthToken,
      { ...DEFAULT_INPUT, storage: 'docker-small-storage' },
    );

    const txArgs = mockCosmosTx.mock.calls[0][3] as string[];
    expect(txArgs).toContain('sku-micro-uuid:1');
    expect(txArgs).toContain('sku-storage-uuid:1');
  });

  it('throws when storage SKU name is not found', async () => {
    const qc = makeQueryClient();
    const cm = makeMockClientManager({ queryClient: qc, address: 'manifest1tenant' });

    await expect(
      deployApp(
        cm as any,
        mockGetAuthToken,
        mockGetLeaseDataAuthToken,
        { ...DEFAULT_INPUT, storage: 'nonexistent-storage' },
      ),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
      message: expect.stringContaining('nonexistent-storage'),
    });
  });
});
