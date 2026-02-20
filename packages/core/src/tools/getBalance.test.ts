import { describe, it, expect, vi } from 'vitest';
import { getBalance } from './getBalance.js';
import type { ManifestQueryClient } from '../client.js';

function makeMockQueryClient(overrides?: {
  balances?: { denom: string; amount: string }[];
  creditAccount?: {
    activeLeaseCount: bigint;
    pendingLeaseCount: bigint;
    reservedAmounts: { denom: string; amount: string }[];
  } | null;
  creditEstimate?: {
    currentBalance: { denom: string; amount: string }[];
    totalRatePerSecond: { denom: string; amount: string }[];
    estimatedDurationSeconds: bigint;
    activeLeaseCount: bigint;
  } | null;
}) {
  const balances = overrides?.balances ?? [{ denom: 'umfx', amount: '1000000' }];
  const creditAccount = overrides?.creditAccount ?? null;
  const creditEstimate = overrides?.creditEstimate ?? null;

  return {
    cosmos: {
      bank: {
        v1beta1: {
          allBalances: vi.fn().mockResolvedValue({ balances }),
        },
      },
    },
    liftedinit: {
      billing: {
        v1: {
          creditAccount: vi.fn().mockImplementation(async () => {
            if (creditAccount === null) {
              throw new Error('key not found');
            }
            return { creditAccount };
          }),
          creditEstimate: vi.fn().mockImplementation(async () => {
            if (creditEstimate === null) {
              throw new Error('credit not found');
            }
            return creditEstimate;
          }),
        },
      },
    },
  } as unknown as ManifestQueryClient;
}

describe('getBalance', () => {
  const address = 'manifest1abc';

  it('should return balances when no credit account exists', async () => {
    const client = makeMockQueryClient();
    const result = await getBalance(client, address);
    expect(result.balances).toEqual([{ denom: 'umfx', amount: '1000000' }]);
    expect(result.credits).toBeNull();
  });

  it('should include credit info when credit account exists', async () => {
    const client = makeMockQueryClient({
      creditAccount: {
        activeLeaseCount: 2n,
        pendingLeaseCount: 1n,
        reservedAmounts: [{ denom: 'umfx', amount: '500' }],
      },
    });
    const result = await getBalance(client, address);
    expect(result.credits).toEqual({
      active_leases: '2',
      pending_leases: '1',
      reserved_amounts: [{ denom: 'umfx', amount: '500' }],
    });
  });

  it('should include spending estimates when credit estimate exists', async () => {
    const client = makeMockQueryClient({
      creditEstimate: {
        currentBalance: [{ denom: 'umfx', amount: '100000' }],
        totalRatePerSecond: [{ denom: 'umfx', amount: '10' }],
        estimatedDurationSeconds: 36000n,
        activeLeaseCount: 1n,
      },
    });
    const result = await getBalance(client, address);
    expect(result.spending_per_hour).toEqual([{ denom: 'umfx', amount: '36000' }]);
    expect(result.hours_remaining).toBe('10.0');
    expect(result.running_apps).toBe('1');
  });

  it('should handle zero duration gracefully', async () => {
    const client = makeMockQueryClient({
      creditEstimate: {
        currentBalance: [],
        totalRatePerSecond: [],
        estimatedDurationSeconds: 0n,
        activeLeaseCount: 0n,
      },
    });
    const result = await getBalance(client, address);
    expect(result.hours_remaining).toBe('0');
  });
});
