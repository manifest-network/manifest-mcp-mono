import { makeMockQueryClient } from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDeploymentReadiness } from './checkDeploymentReadiness.js';

const ADDRESS = 'manifest1abc';

function makeQc(opts: {
  walletBalances?: Array<{ denom: string; amount: string }>;
  creditAccount?: {
    activeLeaseCount: bigint;
    pendingLeaseCount: bigint;
    reservedAmounts: Array<{ denom: string; amount: string }>;
  } | null;
  creditAccountAvailableBalances?: Array<{ denom: string; amount: string }>;
  skus?: Array<{
    uuid: string;
    name: string;
    providerUuid: string;
    basePrice?: { denom: string; amount: string };
    active?: boolean;
  }>;
}) {
  return makeMockQueryClient({
    billing: {
      balances: opts.walletBalances ?? [{ denom: 'umfx', amount: '5000000' }],
      creditAccount: opts.creditAccount ?? null,
      creditAccountAvailableBalances: opts.creditAccountAvailableBalances ?? [],
    },
    sku: {
      skus: opts.skus,
    },
  });
}

describe('checkDeploymentReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ready=true when wallet has balance, credit available, and SKU exists', async () => {
    const qc = makeQc({
      walletBalances: [{ denom: 'umfx', amount: '5000000' }],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'upwr', amount: '1000000' }],
      skus: [
        {
          uuid: 'sku-1',
          name: 'docker-micro',
          providerUuid: 'prov-1',
          basePrice: { denom: 'upwr', amount: '100' },
          active: true,
        },
      ],
    });

    const result = await checkDeploymentReadiness(qc, ADDRESS, {
      size: 'docker-micro',
    });
    expect(result.ready).toBe(true);
    expect(result.missing_steps).toHaveLength(0);
    expect(result.sku?.name).toBe('docker-micro');
    expect(result.sku?.active).toBe(true);
    expect(result.available_sku_names).toEqual(['docker-micro']);
  });

  it('reports missing SKU and offers alternatives', async () => {
    const qc = makeQc({
      skus: [
        {
          uuid: 'sku-2',
          name: 'docker-small',
          providerUuid: 'prov-1',
        },
      ],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'upwr', amount: '1' }],
    });

    const result = await checkDeploymentReadiness(qc, ADDRESS, {
      size: 'docker-massive',
    });
    expect(result.ready).toBe(false);
    expect(result.missing_steps.some((m) => m.includes('docker-small'))).toBe(
      true,
    );
    expect(result.sku).toBeNull();
  });

  it('reports missing credit account', async () => {
    const qc = makeQc({
      creditAccount: null,
      skus: [{ uuid: 'sku-1', name: 'docker-micro', providerUuid: 'prov-1' }],
    });

    const result = await checkDeploymentReadiness(qc, ADDRESS, {
      size: 'docker-micro',
    });
    expect(result.ready).toBe(false);
    expect(
      result.missing_steps.some((m) => m.toLowerCase().includes('credit')),
    ).toBe(true);
  });

  it('reports zero wallet balance', async () => {
    const qc = makeQc({
      walletBalances: [],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'upwr', amount: '1' }],
      skus: [{ uuid: 'sku-1', name: 'docker-micro', providerUuid: 'prov-1' }],
    });

    const result = await checkDeploymentReadiness(qc, ADDRESS, {
      size: 'docker-micro',
    });
    expect(result.ready).toBe(false);
    expect(
      result.missing_steps.some((m) => m.toLowerCase().includes('wallet')),
    ).toBe(true);
  });

  it('size is optional — readiness focuses on wallet/credit only', async () => {
    const qc = makeQc({
      walletBalances: [{ denom: 'umfx', amount: '5000000' }],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'upwr', amount: '1' }],
      skus: [{ uuid: 'sku-1', name: 'docker-micro', providerUuid: 'prov-1' }],
    });

    const result = await checkDeploymentReadiness(qc, ADDRESS);
    expect(result.ready).toBe(true);
    expect(result.sku).toBeNull();
    expect(result.size).toBeNull();
  });

  it('records image input on the result for downstream display', async () => {
    const qc = makeQc({
      walletBalances: [{ denom: 'umfx', amount: '5000000' }],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'upwr', amount: '1' }],
      skus: [{ uuid: 'sku-1', name: 'docker-micro', providerUuid: 'prov-1' }],
    });

    const result = await checkDeploymentReadiness(qc, ADDRESS, {
      image: 'ghcr.io/example/web:v1',
    });
    expect(result.image).toBe('ghcr.io/example/web:v1');
  });
});
