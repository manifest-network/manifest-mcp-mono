import { describe, expect, it, vi } from 'vitest';
import { makeMockQueryClient, makeReadCtx } from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { getBalance } from './getBalance.js';

describe('getBalance', () => {
  const address = 'manifest1abc';

  it('should return balances when no credit account exists', async () => {
    const client = makeMockQueryClient();
    const result = await getBalance(makeReadCtx({ query: client }), address);
    expect(result.balances).toEqual([{ denom: 'umfx', amount: '1000000' }]);
    expect(result.credits).toBeNull();
  });

  it('should include credit info when credit account exists', async () => {
    const client = makeMockQueryClient({
      billing: {
        creditAccount: {
          activeLeaseCount: 2n,
          pendingLeaseCount: 1n,
          reservedAmounts: [{ denom: 'upwr', amount: '500' }],
        },
        creditAccountBalances: [{ denom: 'upwr', amount: '10000' }],
        creditAccountAvailableBalances: [{ denom: 'upwr', amount: '9500' }],
      },
    });
    const result = await getBalance(makeReadCtx({ query: client }), address);
    expect(result.credits).toEqual({
      active_leases: '2',
      pending_leases: '1',
      reserved_amounts: [{ denom: 'upwr', amount: '500' }],
      balances: [{ denom: 'upwr', amount: '10000' }],
      available_balances: [{ denom: 'upwr', amount: '9500' }],
    });
  });

  it('should include spending estimates when credit estimate exists', async () => {
    const client = makeMockQueryClient({
      billing: {
        creditEstimate: {
          currentBalance: [{ denom: 'umfx', amount: '100000' }],
          totalRatePerSecond: [{ denom: 'umfx', amount: '10' }],
          estimatedDurationSeconds: 36000n,
          activeLeaseCount: 1n,
        },
      },
    });
    const result = await getBalance(makeReadCtx({ query: client }), address);
    expect(result.current_balance).toEqual([
      { denom: 'umfx', amount: '100000' },
    ]);
    expect(result.spending_per_hour).toEqual([
      { denom: 'umfx', amount: '36000' },
    ]);
    expect(result.hours_remaining).toBe('10.0');
    expect(result.running_apps).toBe('1');
  });

  it('should handle zero duration gracefully', async () => {
    const client = makeMockQueryClient({
      billing: {
        creditEstimate: {
          currentBalance: [],
          totalRatePerSecond: [],
          estimatedDurationSeconds: 0n,
          activeLeaseCount: 0n,
        },
      },
    });
    const result = await getBalance(makeReadCtx({ query: client }), address);
    expect(result.hours_remaining).toBe('0');
  });

  it('should propagate ManifestMCPError instead of suppressing as not-found', async () => {
    const client = makeMockQueryClient();
    // Override the creditAccount mock to throw a ManifestMCPError
    vi.mocked(client.liftedinit.billing.v1.creditAccount).mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        'credit account not found on disconnected node',
      ),
    );

    await expect(
      getBalance(makeReadCtx({ query: client }), address),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    });
  });

  it('returns credits: null when the chain says the credit account is absent', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.creditAccount).mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.NOT_FOUND,
        'credit account not found',
        {
          httpStatus: 404,
          grpcCode: 5,
          grpcMessage: 'credit account not found',
        },
      ),
    );
    vi.mocked(client.liftedinit.billing.v1.creditEstimate).mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.NOT_FOUND,
        'credit account not found',
        {
          httpStatus: 404,
          grpcCode: 5,
          grpcMessage: 'credit account not found',
        },
      ),
    );

    const result = await getBalance(makeReadCtx({ query: client }), address);
    expect(result.credits).toBeNull();
    expect(result.balances).toBeDefined();
  });

  it('still throws when the credit read fails for a non-not-found reason', async () => {
    const client = makeMockQueryClient();
    vi.mocked(client.liftedinit.billing.v1.creditAccount).mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'LCD query "creditAccount" failed',
        { httpStatus: 500 },
      ),
    );
    await expect(
      getBalance(makeReadCtx({ query: client }), address),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.QUERY_FAILED,
    });
  });

  it('aborts via opts.signal before doing any read', async () => {
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    await expect(
      getBalance(makeReadCtx(), 'manifest1abc', { signal: ac.signal }),
    ).rejects.toThrow('cancelled');
  });
});
