import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

import { makeMockClientManager, makeTxCtx } from '../__test-utils__/mocks.js';
import { asFqdn, asLeaseUuid } from '../brands.js';
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

    const result = await setItemCustomDomain(makeTxCtx({ chain: cm }), {
      leaseUuid: asLeaseUuid(LEASE_UUID),
      customDomain: asFqdn('app.example.com'),
    });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
      true,
      undefined,
      undefined,
    );
    expect(result).toEqual({
      lease_uuid: LEASE_UUID,
      service_name: '',
      custom_domain: 'app.example.com',
      transactionHash: 'TX_HASH',
      code: 0,
      confirmed: true,
    });
  });

  it('waitForConfirmation:false → threads false to cosmosTx and surfaces confirmed:false (hash only)', async () => {
    const cm = makeMockClientManager();
    mockCosmosTx.mockResolvedValue({
      module: 'billing',
      subcommand: 'set-item-custom-domain',
      transactionHash: 'SYNC_HASH',
      code: 0,
      height: '',
      confirmed: false,
    });

    const result = await setItemCustomDomain(
      makeTxCtx({ chain: cm }),
      {
        leaseUuid: asLeaseUuid(LEASE_UUID),
        customDomain: asFqdn('app.example.com'),
      },
      { waitForConfirmation: false },
    );

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
      false,
      undefined,
      undefined,
    );
    expect(result.confirmed).toBe(false);
    expect(result.transactionHash).toBe('SYNC_HASH');
  });

  it('clears the custom domain by passing --clear instead of the customDomain arg', async () => {
    const cm = makeMockClientManager();

    const result = await setItemCustomDomain(makeTxCtx({ chain: cm }), {
      leaseUuid: asLeaseUuid(LEASE_UUID),
      clear: true,
    });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, '--clear'],
      true,
      undefined,
      undefined,
    );
    expect(result.custom_domain).toBe('');
    expect(result.lease_uuid).toBe(LEASE_UUID);
  });

  it('appends --service-name flag when serviceName option is provided', async () => {
    const cm = makeMockClientManager();

    const result = await setItemCustomDomain(makeTxCtx({ chain: cm }), {
      leaseUuid: asLeaseUuid(LEASE_UUID),
      customDomain: asFqdn('app.example.com'),
      serviceName: 'web',
    });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com', '--service-name', 'web'],
      true,
      undefined,
      undefined,
    );
    expect(result.service_name).toBe('web');
  });

  it('combines clear with --service-name (set-or-clear of a stack item)', async () => {
    const cm = makeMockClientManager();

    await setItemCustomDomain(makeTxCtx({ chain: cm }), {
      leaseUuid: asLeaseUuid(LEASE_UUID),
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
      undefined,
    );
  });

  it('omits --service-name when an empty string is supplied (legacy lease)', async () => {
    const cm = makeMockClientManager();

    await setItemCustomDomain(makeTxCtx({ chain: cm }), {
      leaseUuid: asLeaseUuid(LEASE_UUID),
      customDomain: asFqdn('app.example.com'),
      serviceName: '',
    });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
      true,
      undefined,
      undefined,
    );
  });

  it('forwards TxCallOptions (gasMultiplier) through to cosmosTx', async () => {
    const cm = makeMockClientManager();

    await setItemCustomDomain(
      makeTxCtx({ chain: cm }),
      {
        leaseUuid: asLeaseUuid(LEASE_UUID),
        customDomain: asFqdn('app.example.com'),
      },
      { gasMultiplier: 2.5 },
    );

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
      true,
      { gasMultiplier: 2.5 },
      undefined,
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
      setItemCustomDomain(makeTxCtx({ chain: cm }), {
        leaseUuid: asLeaseUuid(LEASE_UUID),
        customDomain: asFqdn('taken.example.com'),
      }),
    ).rejects.toThrow(ManifestMCPError);
  });
});
