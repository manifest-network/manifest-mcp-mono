import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

import { stopApp } from './stopApp.js';
import { cosmosTx } from '../cosmos.js';
import { InMemoryAppRegistry } from '../registry.js';
import { makeMockClientManager } from '../__test-utils__/mocks.js';
import { ManifestMCPError } from '../types.js';

const mockCosmosTx = vi.mocked(cosmosTx);

const ADDRESS = 'manifest1user';

describe('stopApp', () => {
  let registry: InMemoryAppRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new InMemoryAppRegistry();
  });

  it('closes the lease and updates registry to stopped', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      status: 'active',
    });

    const cm = makeMockClientManager({ address: ADDRESS });
    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'close-lease',
      transactionHash: 'TX_HASH',
      code: 0,
      height: '200',
      confirmed: true,
    });

    const result = await stopApp(cm as any, ADDRESS, 'my-app', registry);

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'close-lease',
      ['lease-1'],
      true,
    );
    expect(result).toEqual({
      app_name: 'my-app',
      status: 'stopped',
      transactionHash: 'TX_HASH',
      code: 0,
    });

    const updated = registry.getApp(ADDRESS, 'my-app');
    expect(updated.status).toBe('stopped');
  });

  it('throws when close-lease tx returns nonzero code', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      status: 'active',
    });

    const cm = makeMockClientManager({ address: ADDRESS });
    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'close-lease',
      transactionHash: 'TX_FAIL',
      code: 5,
      height: '200',
      rawLog: 'lease not found',
    });

    await expect(
      stopApp(cm as any, ADDRESS, 'my-app', registry),
    ).rejects.toThrow(ManifestMCPError);

    // Registry should NOT have been updated
    const app = registry.getApp(ADDRESS, 'my-app');
    expect(app.status).toBe('active');
  });

  it('throws when app not found in registry', async () => {
    const cm = makeMockClientManager({ address: ADDRESS });

    await expect(
      stopApp(cm as any, ADDRESS, 'nonexistent', registry),
    ).rejects.toThrow(ManifestMCPError);
  });

  it('propagates tx errors', async () => {
    registry.addApp(ADDRESS, {
      name: 'my-app',
      leaseUuid: 'lease-1',
      status: 'active',
    });

    const cm = makeMockClientManager({ address: ADDRESS });
    mockCosmosTx.mockRejectedValue(new Error('tx failed'));

    await expect(
      stopApp(cm as any, ADDRESS, 'my-app', registry),
    ).rejects.toThrow('tx failed');
  });
});
