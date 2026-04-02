import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

import { makeMockClientManager } from '../__test-utils__/mocks.js';
import { cosmosTx } from '../cosmos.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { stopApp } from './stopApp.js';

const mockCosmosTx = vi.mocked(cosmosTx);

describe('stopApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes the lease on-chain and returns result', async () => {
    const cm = makeMockClientManager();
    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'close-lease',
      transactionHash: 'TX_HASH',
      code: 0,
      height: '200',
      confirmed: true,
    });

    const result = await stopApp(cm as any, 'lease-1');

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'close-lease',
      ['lease-1'],
      true,
      undefined,
    );
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      status: 'stopped',
      transactionHash: 'TX_HASH',
      code: 0,
    });
  });

  it('throws when close-lease tx fails on-chain', async () => {
    const cm = makeMockClientManager();
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'Transaction billing close-lease failed with code 5: lease not found',
      ),
    );

    await expect(stopApp(cm as any, 'lease-1')).rejects.toThrow(
      ManifestMCPError,
    );
  });

  it('propagates tx errors', async () => {
    const cm = makeMockClientManager();
    mockCosmosTx.mockRejectedValue(new Error('tx failed'));

    await expect(stopApp(cm as any, 'lease-1')).rejects.toThrow('tx failed');
  });
});
