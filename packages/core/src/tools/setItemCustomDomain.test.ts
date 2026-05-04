import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

import { makeMockClientManager } from '../__test-utils__/mocks.js';
import { cosmosTx } from '../cosmos.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { setItemCustomDomain } from './setItemCustomDomain.js';

const mockCosmosTx = vi.mocked(cosmosTx);

const LEASE_UUID = '11111111-2222-3333-4444-555555555555';

const TX_RESULT = {
  module: 'billing',
  subcommand: 'set-item-custom-domain',
  transactionHash: 'TX_HASH',
  code: 0,
  height: '200',
  confirmed: true,
};

describe('setItemCustomDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCosmosTx.mockResolvedValue(TX_RESULT);
  });

  it('sets a custom domain via cosmosTx with [lease-uuid, custom-domain] args', async () => {
    const cm = makeMockClientManager();

    const result = await setItemCustomDomain(
      cm as any,
      LEASE_UUID,
      'app.example.com',
    );

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
      true,
      undefined,
    );
    expect(result).toEqual({
      lease_uuid: LEASE_UUID,
      service_name: '',
      custom_domain: 'app.example.com',
      transactionHash: 'TX_HASH',
      code: 0,
    });
  });

  it('clears the custom domain by passing --clear instead of the customDomain arg', async () => {
    const cm = makeMockClientManager();

    const result = await setItemCustomDomain(cm as any, LEASE_UUID, '', {
      clear: true,
    });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, '--clear'],
      true,
      undefined,
    );
    expect(result.custom_domain).toBe('');
    expect(result.lease_uuid).toBe(LEASE_UUID);
  });

  it('appends --service-name flag when serviceName option is provided', async () => {
    const cm = makeMockClientManager();

    const result = await setItemCustomDomain(
      cm as any,
      LEASE_UUID,
      'app.example.com',
      { serviceName: 'web' },
    );

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com', '--service-name', 'web'],
      true,
      undefined,
    );
    expect(result.service_name).toBe('web');
  });

  it('combines clear with --service-name (set-or-clear of a stack item)', async () => {
    const cm = makeMockClientManager();

    await setItemCustomDomain(cm as any, LEASE_UUID, '', {
      clear: true,
      serviceName: 'web',
    });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, '--clear', '--service-name', 'web'],
      true,
      undefined,
    );
  });

  it('omits --service-name when an empty string is supplied (legacy lease)', async () => {
    const cm = makeMockClientManager();

    await setItemCustomDomain(cm as any, LEASE_UUID, 'app.example.com', {
      serviceName: '',
    });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
      true,
      undefined,
    );
  });

  it('forwards TxOverrides to cosmosTx', async () => {
    const cm = makeMockClientManager();

    await setItemCustomDomain(
      cm as any,
      LEASE_UUID,
      'app.example.com',
      undefined,
      { gasMultiplier: 2.5 },
    );

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
      true,
      { gasMultiplier: 2.5 },
    );
  });

  it('propagates structured tx failures from cosmosTx', async () => {
    const cm = makeMockClientManager();
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'Transaction billing set-item-custom-domain failed with code 7: domain already claimed',
      ),
    );

    await expect(
      setItemCustomDomain(cm as any, LEASE_UUID, 'taken.example.com'),
    ).rejects.toThrow(ManifestMCPError);
  });

  it('rejects an empty customDomain when not clearing (would silently clear on chain)', async () => {
    const cm = makeMockClientManager();

    await expect(
      setItemCustomDomain(cm as any, LEASE_UUID, ''),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ManifestMCPError)) return false;
      return (
        error.code === ManifestMCPErrorCode.INVALID_CONFIG &&
        /cannot be empty/.test(error.message) &&
        /clear/.test(error.message)
      );
    });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only customDomain when not clearing', async () => {
    const cm = makeMockClientManager();

    await expect(
      setItemCustomDomain(cm as any, LEASE_UUID, '   '),
    ).rejects.toThrow(ManifestMCPError);
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('still allows clearing with an empty customDomain when options.clear is true', async () => {
    const cm = makeMockClientManager();

    await setItemCustomDomain(cm as any, LEASE_UUID, '', { clear: true });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, '--clear'],
      true,
      undefined,
    );
  });

  it('rejects clear=true combined with a non-empty customDomain (mirrors the MCP tool mutual-exclusion rule)', async () => {
    const cm = makeMockClientManager();

    await expect(
      setItemCustomDomain(cm as any, LEASE_UUID, 'app.example.com', {
        clear: true,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof ManifestMCPError)) return false;
      return (
        error.code === ManifestMCPErrorCode.INVALID_CONFIG &&
        /not both/.test(error.message)
      );
    });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });
});
