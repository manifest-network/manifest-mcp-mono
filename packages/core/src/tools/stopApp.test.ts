import { LeaseState } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../cosmos.js', () => ({
  cosmosTx: vi.fn(),
}));

import {
  makeMockClientManager,
  makeMockQueryClient,
  makeTxCtx,
} from '../__test-utils__/mocks.js';
import { asLeaseUuid } from '../brands.js';
import { cosmosTx } from '../cosmos.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { stopApp } from './stopApp.js';

const mockCosmosTx = vi.mocked(cosmosTx);
const UUID = asLeaseUuid('lease-1');

// A CosmosClientManager whose getQueryClient() returns a client resolving the given lease.
function cmWithLease(lease: unknown) {
  return makeMockClientManager({
    queryClient: makeMockQueryClient({
      billing: { lease: lease as never },
    }),
  });
}

function txOk(subcommand: string) {
  return {
    module: 'billing',
    subcommand,
    transactionHash: 'TX_HASH',
    code: 0,
    height: '200',
    confirmed: true,
  };
}

describe('stopApp', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ACTIVE → close-lease → outcome stopped', async () => {
    const cm = cmWithLease({
      uuid: 'lease-1',
      state: LeaseState.LEASE_STATE_ACTIVE,
      providerUuid: 'p1',
    });
    mockCosmosTx.mockResolvedValue(txOk('close-lease'));

    const result = await stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'close-lease',
      ['lease-1'],
      true,
      undefined,
      undefined,
    );
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      outcome: 'stopped',
      lease_state: 'LEASE_STATE_CLOSED',
      transactionHash: 'TX_HASH',
      code: 0,
    });
  });

  it('PENDING → cancel-lease → outcome cancelled', async () => {
    const cm = cmWithLease({
      uuid: 'lease-1',
      state: LeaseState.LEASE_STATE_PENDING,
      providerUuid: 'p1',
    });
    mockCosmosTx.mockResolvedValue(txOk('cancel-lease'));

    const result = await stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID });

    expect(mockCosmosTx).toHaveBeenCalledWith(
      cm,
      'billing',
      'cancel-lease',
      ['lease-1'],
      true,
      undefined,
      undefined,
    );
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      outcome: 'cancelled',
      lease_state: 'LEASE_STATE_REJECTED',
      transactionHash: 'TX_HASH',
      code: 0,
    });
  });

  it('already CLOSED → no broadcast → already_inactive', async () => {
    const cm = cmWithLease({
      uuid: 'lease-1',
      state: LeaseState.LEASE_STATE_CLOSED,
      providerUuid: 'p1',
    });

    const result = await stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID });

    expect(mockCosmosTx).not.toHaveBeenCalled();
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_CLOSED',
    });
  });

  it('already REJECTED → already_inactive carries rejection_reason verbatim', async () => {
    const cm = cmWithLease({
      uuid: 'lease-1',
      state: LeaseState.LEASE_STATE_REJECTED,
      providerUuid: 'p1',
      rejectionReason: 'provider out of capacity',
    });

    const result = await stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID });

    expect(mockCosmosTx).not.toHaveBeenCalled();
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      rejection_reason: 'provider out of capacity',
    });
  });

  it('already REJECTED with a missing rejectionReason → rejection_reason coerced to "" (never undefined)', async () => {
    const cm = cmWithLease({
      uuid: 'lease-1',
      state: LeaseState.LEASE_STATE_REJECTED,
      providerUuid: 'p1',
      // rejectionReason intentionally omitted (guards a decode path that drops it)
    });

    const result = await stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID });

    expect(result).toEqual({
      lease_uuid: 'lease-1',
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      rejection_reason: '',
    });
  });

  it('lease not found → QUERY_FAILED', async () => {
    const cm = cmWithLease(null);
    await expect(
      stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('undecodable / UNSPECIFIED state → TX_FAILED, no broadcast', async () => {
    const cm = cmWithLease({
      uuid: 'lease-1',
      state: LeaseState.LEASE_STATE_UNSPECIFIED,
      providerUuid: 'p1',
    });
    await expect(
      stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('TOCTOU (a): ACTIVE pre-query, close rejects, re-query CLOSED → already_inactive', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    qc.liftedinit.billing.v1.lease = vi
      .fn()
      .mockResolvedValueOnce({
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'p1',
        },
      })
      .mockResolvedValueOnce({
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_CLOSED,
          providerUuid: 'p1',
        },
      });
    const cm = makeMockClientManager({ queryClient: qc });
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'lease not active'),
    );

    const result = await stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID });
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_CLOSED',
    });
  });

  it('TOCTOU (b): PENDING pre-query, cancel rejects, re-query ACTIVE → typed retry error, no re-dispatch', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    qc.liftedinit.billing.v1.lease = vi
      .fn()
      .mockResolvedValueOnce({
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_PENDING,
          providerUuid: 'p1',
        },
      })
      .mockResolvedValueOnce({
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_ACTIVE,
          providerUuid: 'p1',
        },
      });
    const cm = makeMockClientManager({ queryClient: qc });
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'lease not in pending state',
      ),
    );

    await expect(
      stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID }),
    ).rejects.toThrow(/state changed during teardown/i);
    // only the ONE (cancel) broadcast happened — no auto re-dispatch to close
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
  });

  it('TOCTOU (c): PENDING pre-query, cancel rejects, re-query REJECTED → already_inactive with re-query reason', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    qc.liftedinit.billing.v1.lease = vi
      .fn()
      .mockResolvedValueOnce({
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_PENDING,
          providerUuid: 'p1',
          rejectionReason: '',
        },
      })
      .mockResolvedValueOnce({
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_REJECTED,
          providerUuid: 'p1',
          rejectionReason: 'cancelled by tenant',
        },
      });
    const cm = makeMockClientManager({ queryClient: qc });
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        'lease not in pending state',
      ),
    );

    const result = await stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID });
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_REJECTED',
      rejection_reason: 'cancelled by tenant',
    });
  });

  it('already EXPIRED → no broadcast → already_inactive', async () => {
    const cm = cmWithLease({
      uuid: 'lease-1',
      state: LeaseState.LEASE_STATE_EXPIRED,
      providerUuid: 'p1',
    });
    const result = await stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID });
    expect(mockCosmosTx).not.toHaveBeenCalled();
    expect(result).toEqual({
      lease_uuid: 'lease-1',
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_EXPIRED',
    });
  });

  it('pre-query transport failure → QUERY_FAILED, no broadcast', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    qc.liftedinit.billing.v1.lease = vi
      .fn()
      .mockRejectedValue(new Error('RPC down'));
    const cm = makeMockClientManager({ queryClient: qc });
    await expect(
      stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.QUERY_FAILED });
    expect(mockCosmosTx).not.toHaveBeenCalled();
  });

  it('TOCTOU close-path: ACTIVE pre-query, close rejects, re-query still ACTIVE → rethrows the ORIGINAL error (not "state changed")', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    qc.liftedinit.billing.v1.lease = vi.fn().mockResolvedValue({
      lease: {
        uuid: 'lease-1',
        state: LeaseState.LEASE_STATE_ACTIVE,
        providerUuid: 'p1',
      },
    });
    const cm = makeMockClientManager({ queryClient: qc });
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'out of gas'),
    );
    await expect(
      stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID }),
    ).rejects.toThrow('out of gas');
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
  });

  it('TOCTOU re-query fails: cancel rejects, re-query throws → surfaces the ORIGINAL broadcast error', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    qc.liftedinit.billing.v1.lease = vi
      .fn()
      .mockResolvedValueOnce({
        lease: {
          uuid: 'lease-1',
          state: LeaseState.LEASE_STATE_PENDING,
          providerUuid: 'p1',
        },
      })
      .mockRejectedValueOnce(new Error('RPC down'));
    const cm = makeMockClientManager({ queryClient: qc });
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'cancel boom'),
    );
    await expect(
      stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID }),
    ).rejects.toThrow('cancel boom');
  });

  it('TOCTOU unchanged: cancel rejects, re-query still PENDING → rethrows the ORIGINAL error, one broadcast', async () => {
    const qc = makeMockQueryClient({ billing: { lease: null } });
    qc.liftedinit.billing.v1.lease = vi.fn().mockResolvedValue({
      lease: {
        uuid: 'lease-1',
        state: LeaseState.LEASE_STATE_PENDING,
        providerUuid: 'p1',
      },
    });
    const cm = makeMockClientManager({ queryClient: qc });
    mockCosmosTx.mockRejectedValue(
      new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'cancel boom'),
    );
    await expect(
      stopApp(makeTxCtx({ chain: cm }), { leaseUuid: UUID }),
    ).rejects.toThrow('cancel boom');
    expect(mockCosmosTx).toHaveBeenCalledTimes(1);
  });
});
