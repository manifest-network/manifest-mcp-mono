import { describe, expect, it, vi } from 'vitest';
import { routeBillingQuery } from './billing.js';

function makeMockBillingClient(overrides?: {
  creditAccount?: {
    creditAccount?: unknown;
    balances?: unknown;
    availableBalances?: unknown;
  };
  providerWithdrawable?: {
    amounts?: unknown;
    leaseCount?: bigint;
    hasMore?: boolean;
  };
}) {
  const creditAccount = overrides?.creditAccount ?? {
    creditAccount: {
      tenant: 'manifest1abc',
      activeLeaseCount: 0n,
      pendingLeaseCount: 0n,
      reservedAmounts: [],
    },
    balances: [{ denom: 'upwr', amount: '10000' }],
    availableBalances: [{ denom: 'upwr', amount: '9500' }],
  };
  const providerWithdrawable = overrides?.providerWithdrawable ?? {
    amounts: [{ denom: 'upwr', amount: '500' }],
    leaseCount: 3n,
    hasMore: false,
  };

  return {
    liftedinit: {
      billing: {
        v1: {
          creditAccount: vi.fn().mockResolvedValue(creditAccount),
          providerWithdrawable: vi.fn().mockResolvedValue(providerWithdrawable),
        },
      },
    },
  } as never;
}

describe('routeBillingQuery', () => {
  describe('credit-account', () => {
    it('surfaces creditAccount, balances, and availableBalances from the response', async () => {
      const qc = makeMockBillingClient();
      const result = await routeBillingQuery(qc, 'credit-account', [
        'manifest1abc',
      ]);
      expect(result).toEqual({
        creditAccount: expect.objectContaining({ tenant: 'manifest1abc' }),
        balances: [{ denom: 'upwr', amount: '10000' }],
        availableBalances: [{ denom: 'upwr', amount: '9500' }],
      });
    });

    it('throws when tenant address is missing', async () => {
      const qc = makeMockBillingClient();
      await expect(
        routeBillingQuery(qc, 'credit-account', []),
      ).rejects.toThrow();
    });
  });

  describe('provider-withdrawable', () => {
    it('surfaces amounts, leaseCount, and hasMore from the response', async () => {
      const qc = makeMockBillingClient();
      const result = await routeBillingQuery(qc, 'provider-withdrawable', [
        'provider-uuid-1',
      ]);
      expect(result).toEqual({
        amounts: [{ denom: 'upwr', amount: '500' }],
        leaseCount: 3n,
        hasMore: false,
      });
    });

    it('passes hasMore=true through unchanged', async () => {
      const qc = makeMockBillingClient({
        providerWithdrawable: {
          amounts: [{ denom: 'upwr', amount: '100' }],
          leaseCount: 100n,
          hasMore: true,
        },
      });
      const result = await routeBillingQuery(qc, 'provider-withdrawable', [
        'provider-uuid-1',
      ]);
      expect(result).toMatchObject({ leaseCount: 100n, hasMore: true });
    });

    it('throws when provider uuid is missing', async () => {
      const qc = makeMockBillingClient();
      await expect(
        routeBillingQuery(qc, 'provider-withdrawable', []),
      ).rejects.toThrow();
    });
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockBillingClient();
    await expect(routeBillingQuery(qc, 'nonexistent', [])).rejects.toThrow();
  });
});
