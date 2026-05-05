import { describe, expect, it, vi } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
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
  leaseByCustomDomain?: {
    lease?: unknown;
    serviceName?: string;
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
  const leaseByCustomDomain = overrides?.leaseByCustomDomain ?? {
    lease: { uuid: 'lease-1', tenant: 'manifest1abc' },
    serviceName: 'web',
  };

  return {
    liftedinit: {
      billing: {
        v1: {
          creditAccount: vi.fn().mockResolvedValue(creditAccount),
          providerWithdrawable: vi.fn().mockResolvedValue(providerWithdrawable),
          leaseByCustomDomain: vi.fn().mockResolvedValue(leaseByCustomDomain),
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

  describe('lease-by-custom-domain', () => {
    it('returns lease and serviceName from the response', async () => {
      const qc = makeMockBillingClient();
      const result = await routeBillingQuery(qc, 'lease-by-custom-domain', [
        'app.example.com',
      ]);
      expect(result).toEqual({
        lease: { uuid: 'lease-1', tenant: 'manifest1abc' },
        serviceName: 'web',
      });
    });

    it('forwards an empty serviceName for legacy 1-item leases', async () => {
      const qc = makeMockBillingClient({
        leaseByCustomDomain: {
          lease: { uuid: 'lease-2' },
          serviceName: '',
        },
      });
      const result = await routeBillingQuery(qc, 'lease-by-custom-domain', [
        'legacy.example.com',
      ]);
      expect(result).toMatchObject({ serviceName: '' });
    });

    it('rejects an empty <custom-domain> arg with INVALID_CONFIG before querying the chain', async () => {
      const qc = makeMockBillingClient();
      const billingParams = (
        qc as {
          liftedinit: {
            billing: { v1: { leaseByCustomDomain: ReturnType<typeof vi.fn> } };
          };
        }
      ).liftedinit.billing.v1.leaseByCustomDomain;
      await expect(
        routeBillingQuery(qc, 'lease-by-custom-domain', ['']),
      ).rejects.toSatisfy((error: unknown) => {
        if (!(error instanceof ManifestMCPError)) return false;
        return (
          error.code === ManifestMCPErrorCode.INVALID_CONFIG &&
          /cannot be empty/.test(error.message)
        );
      });
      expect(billingParams).not.toHaveBeenCalled();
    });

    it('throws when custom-domain arg is missing', async () => {
      const qc = makeMockBillingClient();
      await expect(
        routeBillingQuery(qc, 'lease-by-custom-domain', []),
      ).rejects.toThrow();
    });

    it('trims surrounding whitespace before querying the chain', async () => {
      const qc = makeMockBillingClient();
      const billingFn = (
        qc as {
          liftedinit: {
            billing: { v1: { leaseByCustomDomain: ReturnType<typeof vi.fn> } };
          };
        }
      ).liftedinit.billing.v1.leaseByCustomDomain;
      await routeBillingQuery(qc, 'lease-by-custom-domain', [
        '  app.example.com  ',
      ]);
      expect(billingFn).toHaveBeenCalledWith({
        customDomain: 'app.example.com',
      });
    });

    it('rejects whitespace-only <custom-domain> with INVALID_CONFIG', async () => {
      const qc = makeMockBillingClient();
      const billingFn = (
        qc as {
          liftedinit: {
            billing: { v1: { leaseByCustomDomain: ReturnType<typeof vi.fn> } };
          };
        }
      ).liftedinit.billing.v1.leaseByCustomDomain;
      await expect(
        routeBillingQuery(qc, 'lease-by-custom-domain', ['   ']),
      ).rejects.toSatisfy((error: unknown) => {
        if (!(error instanceof ManifestMCPError)) return false;
        return (
          error.code === ManifestMCPErrorCode.INVALID_CONFIG &&
          /cannot be empty/.test(error.message)
        );
      });
      expect(billingFn).not.toHaveBeenCalled();
    });
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockBillingClient();
    await expect(routeBillingQuery(qc, 'nonexistent', [])).rejects.toThrow();
  });
});
