import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

import { makeMockClientManager } from '../__test-utils__/mocks.js';
import { cosmosTx } from '../cosmos.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { fundCredits } from './fundCredits.js';

const mockCosmosTx = vi.mocked(cosmosTx);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fundCredits', () => {
  it('defaults tenant to the sender address', async () => {
    const cm = makeMockClientManager({ address: 'manifest1sender' });
    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'fund-credit',
      transactionHash: 'HASH123',
      code: 0,
      height: '100',
      confirmed: true,
    });

    const result = await fundCredits(cm as any, '10000000umfx');

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'fund-credit',
      ['manifest1sender', '10000000umfx'],
      true,
      undefined,
    );
    expect(result).toEqual({
      module: 'billing',
      subcommand: 'fund-credit',
      transactionHash: 'HASH123',
      code: 0,
      height: '100',
      confirmed: true,
      sender: 'manifest1sender',
      tenant: 'manifest1sender',
      amount: '10000000umfx',
    });
  });

  it('routes explicit tenant through and echoes it in the result', async () => {
    const cm = makeMockClientManager({ address: 'manifest1sender' });
    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'fund-credit',
      transactionHash: 'HASH456',
      code: 0,
      height: '101',
      confirmed: true,
    });

    const result = await fundCredits(
      cm as any,
      '10000000umfx',
      undefined,
      'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
    );

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'fund-credit',
      ['manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg', '10000000umfx'],
      true,
      undefined,
    );
    expect(result).toEqual({
      module: 'billing',
      subcommand: 'fund-credit',
      transactionHash: 'HASH456',
      code: 0,
      height: '101',
      confirmed: true,
      sender: 'manifest1sender',
      tenant: 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
      amount: '10000000umfx',
    });
  });

  it('throws when tx fails on-chain', async () => {
    const cm = makeMockClientManager({ address: 'manifest1sender' });
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'Transaction billing fund-credit failed with code 5: insufficient funds',
      ),
    );

    await expect(fundCredits(cm as any, '10000000umfx')).rejects.toThrow(
      ManifestMCPError,
    );
  });

  it('propagates errors from cosmosTx', async () => {
    const cm = makeMockClientManager();
    mockCosmosTx.mockRejectedValue(new Error('insufficient funds'));

    await expect(fundCredits(cm as any, '999umfx')).rejects.toThrow(
      'insufficient funds',
    );
  });
});
