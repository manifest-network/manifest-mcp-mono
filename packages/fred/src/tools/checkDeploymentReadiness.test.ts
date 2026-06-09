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
    expect(result.available_skus.map((s) => s.name)).toContain('docker-micro');
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

  it('caps available_skus so a large catalog cannot bloat the response', async () => {
    const skus = Array.from({ length: 75 }, (_, i) => ({
      uuid: `sku-${i}`,
      name: `tier-${i}`,
      providerUuid: 'prov-1',
    }));
    const qc = makeQc({
      walletBalances: [{ denom: 'umfx', amount: '5000000' }],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'upwr', amount: '1' }],
      skus,
    });

    const result = await checkDeploymentReadiness(qc, ADDRESS, {
      size: 'tier-60',
    });
    // The requested tier still resolves (unique name → single candidate).
    expect(result.sku?.name).toBe('tier-60');
    expect(result.sku_candidates).toHaveLength(1);
    expect(result.available_skus.length).toBe(50);
  });

  it('ENG-258: returns all candidates for a duplicate name with distinct provider/price', async () => {
    const qc = makeQc({
      skus: [
        {
          uuid: 'a',
          name: 'docker-micro',
          providerUuid: 'p1',
          basePrice: { amount: '100', denom: 'umfx' },
        },
        {
          uuid: 'b',
          name: 'docker-micro',
          providerUuid: 'p2',
          basePrice: { amount: '120', denom: 'umfx' },
        },
      ],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'umfx', amount: '999999' }],
    });
    const res = await checkDeploymentReadiness(qc, ADDRESS, {
      size: 'docker-micro',
    });
    expect(res.sku_candidates).toHaveLength(2);
    expect(res.sku).toBeNull(); // ambiguous → no determinate single pick
    expect(res.ready).toBe(false);
    expect(res.missing_steps.join(' ')).toMatch(/provider_uuid|sku_uuid/);
  });

  it('ENG-258: narrows to a single candidate with provider_uuid', async () => {
    const qc = makeQc({
      skus: [
        {
          uuid: 'a',
          name: 'docker-micro',
          providerUuid: 'p1',
          basePrice: { amount: '100', denom: 'umfx' },
        },
        {
          uuid: 'b',
          name: 'docker-micro',
          providerUuid: 'p2',
          basePrice: { amount: '120', denom: 'umfx' },
        },
      ],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'umfx', amount: '999999' }],
    });
    const res = await checkDeploymentReadiness(qc, ADDRESS, {
      size: 'docker-micro',
      providerUuid: 'p2',
    });
    expect(res.sku_candidates).toHaveLength(1);
    expect(res.sku?.uuid).toBe('b');
  });

  it('ENG-258: skuUuid bypasses the name filter — SKU with a different name than size is still resolved', async () => {
    // The key scenario: skuUuid 'b' has name 'docker-large', but the caller
    // passes size: 'docker-micro'. Old AND-filter semantics would drop 'b' because
    // name !== 'docker-micro'. The correct bypass semantics return 'b' regardless.
    const qc = makeQc({
      skus: [
        {
          uuid: 'a',
          name: 'docker-micro',
          providerUuid: 'p1',
          basePrice: { amount: '100', denom: 'umfx' },
        },
        {
          uuid: 'b',
          name: 'docker-large',
          providerUuid: 'p2',
          basePrice: { amount: '120', denom: 'umfx' },
        },
      ],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'umfx', amount: '999999' }],
    });
    const res = await checkDeploymentReadiness(qc, ADDRESS, {
      size: 'docker-micro', // different from the target SKU name — must be ignored
      skuUuid: 'b',
    });
    expect(res.sku_candidates).toHaveLength(1);
    expect(res.sku?.uuid).toBe('b');
    expect(res.sku?.name).toBe('docker-large');
    expect(res.ready).toBe(true);
    expect(res.missing_steps).toHaveLength(0);
  });

  it('ENG-258: skuUuid-only (no size) resolves the SKU by identity', async () => {
    const qc = makeQc({
      skus: [
        {
          uuid: 'a',
          name: 'docker-micro',
          providerUuid: 'p1',
          basePrice: { amount: '100', denom: 'umfx' },
        },
        {
          uuid: 'b',
          name: 'docker-micro',
          providerUuid: 'p2',
          basePrice: { amount: '120', denom: 'umfx' },
        },
      ],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'umfx', amount: '999999' }],
    });
    const res = await checkDeploymentReadiness(qc, ADDRESS, {
      skuUuid: 'b',
    });
    expect(res.sku_candidates).toHaveLength(1);
    expect(res.sku?.uuid).toBe('b');
  });

  it('ENG-258: skuUuid not found → missing_steps mentions the uuid', async () => {
    const qc = makeQc({
      skus: [
        {
          uuid: 'a',
          name: 'docker-micro',
          providerUuid: 'p1',
        },
      ],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'umfx', amount: '999999' }],
    });
    const res = await checkDeploymentReadiness(qc, ADDRESS, {
      skuUuid: 'nonexistent-uuid',
    });
    expect(res.sku).toBeNull();
    expect(res.sku_candidates).toHaveLength(0);
    expect(res.ready).toBe(false);
    expect(res.missing_steps.some((m) => m.includes('nonexistent-uuid'))).toBe(
      true,
    );
  });

  it('ENG-258: skuUuid not found on specific provider → missing_steps mentions uuid and provider', async () => {
    const qc = makeQc({
      skus: [
        {
          uuid: 'a',
          name: 'docker-micro',
          providerUuid: 'p1',
        },
      ],
      creditAccount: {
        activeLeaseCount: 0n,
        pendingLeaseCount: 0n,
        reservedAmounts: [],
      },
      creditAccountAvailableBalances: [{ denom: 'umfx', amount: '999999' }],
    });
    // SKU 'a' exists but on p1, not p2
    const res = await checkDeploymentReadiness(qc, ADDRESS, {
      skuUuid: 'a',
      providerUuid: 'p2',
    });
    expect(res.sku).toBeNull();
    expect(res.sku_candidates).toHaveLength(0);
    expect(res.ready).toBe(false);
    expect(res.missing_steps.some((m) => m.includes('a'))).toBe(true);
    expect(res.missing_steps.some((m) => m.includes('p2'))).toBe(true);
  });

  it('ENG-258: exposes available_skus with uuid + provider', async () => {
    const qc = makeQc({
      skus: [{ uuid: 'a', name: 'docker-micro', providerUuid: 'p1' }],
    });
    const res = await checkDeploymentReadiness(qc, ADDRESS, {});
    expect(res.available_skus).toContainEqual({
      name: 'docker-micro',
      uuid: 'a',
      provider_uuid: 'p1',
    });
  });
});
