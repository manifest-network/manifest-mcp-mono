import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return { ...actual, cosmosTx: vi.fn(), setItemCustomDomain: vi.fn() };
});

vi.mock('../http/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/provider.js')>();
  return {
    ...actual,
    uploadLeaseData: vi.fn(),
    getLeaseConnectionInfo: vi.fn(),
  };
});

vi.mock('../http/fred.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../http/fred.js')>();
  return { ...actual, pollLeaseUntilReady: vi.fn() };
});

import {
  cosmosTx,
  isRetryableError,
  LeaseState,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  makeMockClientManager,
  makeMockQueryClient,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { pollLeaseUntilReady } from '../http/fred.js';
import { getLeaseConnectionInfo, uploadLeaseData } from '../http/provider.js';
import { deployApp } from './deployApp.js';
import { deployManifest, findSkuUuid } from './deployManifest.js';

const mockCosmosTx = vi.mocked(cosmosTx);
const mockUpload = vi.mocked(uploadLeaseData);
const mockPoll = vi.mocked(pollLeaseUntilReady);
const mockGetLeaseConnectionInfo = vi.mocked(getLeaseConnectionInfo);
const getAuthToken = vi.fn(async () => 'auth');
const getLeaseDataAuthToken = vi.fn(async () => 'lease-data');

function deps(cm: unknown) {
  return { clientManager: cm as any, getAuthToken, getLeaseDataAuthToken };
}
function singleManifest() {
  return JSON.stringify({ image: 'nginx:alpine', ports: { '80/tcp': {} } });
}

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

function qcWithTwoProviders() {
  return makeMockQueryClient({
    sku: {
      providers: [
        { uuid: 'prov-1', address: 'm1', apiUrl: 'http://p1', active: true },
        { uuid: 'prov-2', address: 'm2', apiUrl: 'http://p2', active: true },
      ],
      skus: [
        {
          uuid: 'sku-compute',
          name: 'docker-micro',
          providerUuid: 'prov-1',
          basePrice: { amount: '1', denom: 'umfx' },
        },
        {
          uuid: 'sku-store-p2',
          name: 'storage-10g',
          providerUuid: 'prov-2',
          basePrice: { amount: '1', denom: 'umfx' },
        },
      ],
      providerLookup: {
        'prov-1': { provider: { apiUrl: 'http://p1' } } as any,
      },
    },
  });
}

describe('findSkuUuid provider filter (ENG-258 #2)', () => {
  it('rejects a tier that exists only on a different provider with non-retryable INVALID_CONFIG', async () => {
    const qc = qcWithTwoProviders();
    let thrown: unknown;
    try {
      await findSkuUuid(qc as any, 'storage-10g', 'prov-1');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManifestMCPError);
    expect((thrown as ManifestMCPError).code).toBe(
      ManifestMCPErrorCode.INVALID_CONFIG,
    );
    expect((thrown as ManifestMCPError).message).toContain('prov-1');
    expect(isRetryableError(thrown)).toBe(false);
  });

  it('resolves a tier on the named provider', async () => {
    const qc = qcWithTwoProviders();
    const { skuUuid } = await findSkuUuid(qc as any, 'storage-10g', 'prov-2');
    expect(skuUuid).toBe('sku-store-p2');
  });
});

describe('deployManifest', () => {
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

    mockUpload.mockResolvedValue(undefined);
    mockPoll.mockResolvedValue({
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

  it('deploys a single-service manifest and uploads the ORIGINAL bytes', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const manifest = singleManifest();
    const res = await deployManifest(
      { manifest, sku: { kind: 'byName', size: 'docker-micro' } },
      deps(cm),
    );
    expect(res.state).toBe(LeaseState.LEASE_STATE_ACTIVE);
    const uploaded = new TextDecoder().decode(mockUpload.mock.calls[0][2]);
    expect(uploaded).toBe(manifest); // byte-identical, not re-serialized
  });

  it('ENG-258 #1: kind:resolved skips the SKU query', async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc.liftedinit.sku.v1, 'sKUs');
    const cm = makeMockClientManager({
      queryClient: qc,
      address: 'manifest1tenant',
    });
    await deployManifest(
      {
        manifest: singleManifest(),
        sku: { kind: 'resolved', skuUuid: 'sku-x', providerUuid: 'prov-1' },
      },
      deps(cm),
    );
    expect(spy).not.toHaveBeenCalled();
    // create-lease used the supplied skuUuid verbatim:
    expect(mockCosmosTx.mock.calls[0][3]).toContain('sku-x:1');
  });

  it('rejects an oversized manifest before any tx', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    const huge = JSON.stringify({
      image: 'x',
      ports: { '80/tcp': {} },
      labels: { big: 'A'.repeat(300_000) },
    });
    await expect(
      deployManifest(
        { manifest: huge, sku: { kind: 'byName', size: 'docker-micro' } },
        deps(cm),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('rejects an invalid manifest BEFORE create-lease', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    await expect(
      deployManifest(
        {
          manifest: '{"image":""}',
          sku: { kind: 'byName', size: 'docker-micro' },
        },
        deps(cm),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('wrapper: builder output passes validateManifest (no self-built manifest is rejected)', async () => {
    const cm = makeMockClientManager({
      queryClient: makeQueryClient(),
      address: 'manifest1tenant',
    });
    // a representative typed input that exercises many builder fields:
    await expect(
      deployApp(cm as any, getAuthToken, getLeaseDataAuthToken, {
        image: 'nginx:alpine',
        port: 80,
        size: 'docker-micro',
        env: { FOO: 'bar' },
        command: ['sh'],
        labels: { a: 'b' },
      }),
    ).resolves.toMatchObject({ state: LeaseState.LEASE_STATE_ACTIVE });
  });
});
