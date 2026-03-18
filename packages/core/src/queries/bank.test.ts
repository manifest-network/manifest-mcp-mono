import { describe, expect, it, vi } from 'vitest';
import { routeBankQuery } from './bank.js';

function makeMockBankClient() {
  return {
    cosmos: {
      bank: {
        v1beta1: {
          balance: vi.fn().mockResolvedValue({
            balance: { denom: 'umfx', amount: '1000000' },
          }),
          allBalances: vi.fn().mockResolvedValue({
            balances: [{ denom: 'umfx', amount: '500' }],
            pagination: undefined,
          }),
          spendableBalances: vi.fn().mockResolvedValue({
            balances: [],
            pagination: undefined,
          }),
          totalSupply: vi.fn().mockResolvedValue({
            supply: [{ denom: 'umfx', amount: '999999' }],
            pagination: undefined,
          }),
          supplyOf: vi.fn().mockResolvedValue({
            amount: { denom: 'umfx', amount: '999999' },
          }),
          params: vi.fn().mockResolvedValue({
            params: { defaultSendEnabled: true },
          }),
          denomMetadata: vi.fn().mockResolvedValue({
            metadata: { base: 'umfx' },
          }),
          denomsMetadata: vi.fn().mockResolvedValue({
            metadatas: [],
            pagination: undefined,
          }),
          sendEnabled: vi.fn().mockResolvedValue({
            sendEnabled: [],
            pagination: undefined,
          }),
        },
      },
    },
  } as any;
}

describe('routeBankQuery', () => {
  it('routes balance subcommand', async () => {
    const qc = makeMockBankClient();
    const result = await routeBankQuery(qc, 'balance', [
      'manifest1abc',
      'umfx',
    ]);
    expect(result).toHaveProperty('balance');
    expect(qc.cosmos.bank.v1beta1.balance).toHaveBeenCalledWith({
      address: 'manifest1abc',
      denom: 'umfx',
    });
  });

  it('routes balances subcommand with pagination', async () => {
    const qc = makeMockBankClient();
    const result = await routeBankQuery(qc, 'balances', ['manifest1abc']);
    expect(result).toHaveProperty('balances');
  });

  it('routes params subcommand', async () => {
    const qc = makeMockBankClient();
    const result = await routeBankQuery(qc, 'params', []);
    expect(result).toHaveProperty('params');
  });

  it('routes supply-of subcommand', async () => {
    const qc = makeMockBankClient();
    const result = await routeBankQuery(qc, 'supply-of', ['umfx']);
    expect(result).toHaveProperty('amount');
  });

  it('throws on unsupported subcommand', async () => {
    const qc = makeMockBankClient();
    await expect(routeBankQuery(qc, 'nonexistent', [])).rejects.toThrow();
  });

  it('throws when balance args are missing', async () => {
    const qc = makeMockBankClient();
    await expect(
      routeBankQuery(qc, 'balance', ['manifest1abc']),
    ).rejects.toThrow('address');
  });
});
