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
  it('calls cosmosTx with billing fund-credit and returns result', async () => {
    const cm = makeMockClientManager({ address: 'manifest1tenant' });
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
      ['manifest1tenant', '10000000umfx'],
      true,
      undefined,
    );
    expect(result.transactionHash).toBe('HASH123');
    expect(result.code).toBe(0);
    expect(result.confirmed).toBe(true);
  });

  it('throws when tx fails on-chain', async () => {
    const cm = makeMockClientManager({ address: 'manifest1tenant' });
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
