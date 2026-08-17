import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

import { makeMockClientManager, makeTxCtx } from '../__test-utils__/mocks.js';
import { asAddress } from '../brands.js';
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

    const result = await fundCredits(makeTxCtx({ chain: cm }), {
      amount: '10000000umfx',
    });

    // Read the slots off the recorded call rather than pinning the whole argument
    // list: toHaveBeenCalledWith is exact-arity, so any parameter appended to
    // cosmosTx would break every assertion in this file at once. Every claim below
    // is unchanged — only the mechanism is, and slots count from the START (ENG-706).
    const [
      client,
      module,
      subcommand,
      txArgs,
      waitForConfirmation,
      overrides,
      txExtras,
    ] = mockCosmosTx.mock.calls[0]!;
    expect({
      client,
      module,
      subcommand,
      txArgs,
      waitForConfirmation,
      overrides,
      txExtras,
    }).toEqual({
      client: cm,
      module: 'billing',
      subcommand: 'fund-credit',
      txArgs: ['manifest1sender', '10000000umfx'],
      waitForConfirmation: true,
      overrides: undefined,
      txExtras: undefined,
    });
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

    const result = await fundCredits(makeTxCtx({ chain: cm }), {
      amount: '10000000umfx',
      tenant: asAddress('manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg'),
    });

    const [
      client,
      module,
      subcommand,
      txArgs,
      waitForConfirmation,
      overrides,
      txExtras,
    ] = mockCosmosTx.mock.calls[0]!;
    expect({
      client,
      module,
      subcommand,
      txArgs,
      waitForConfirmation,
      overrides,
      txExtras,
    }).toEqual({
      client: cm,
      module: 'billing',
      subcommand: 'fund-credit',
      txArgs: [
        'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg',
        '10000000umfx',
      ],
      waitForConfirmation: true,
      overrides: undefined,
      txExtras: undefined,
    });
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

    await expect(
      fundCredits(makeTxCtx({ chain: cm }), { amount: '10000000umfx' }),
    ).rejects.toThrow(ManifestMCPError);
  });

  it('propagates errors from cosmosTx', async () => {
    const cm = makeMockClientManager();
    mockCosmosTx.mockRejectedValue(new Error('insufficient funds'));

    await expect(
      fundCredits(makeTxCtx({ chain: cm }), { amount: '999umfx' }),
    ).rejects.toThrow('insufficient funds');
  });
});
