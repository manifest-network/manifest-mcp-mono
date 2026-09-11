import { toBech32 } from '@cosmjs/encoding';
import type {
  DeliverTxResponse,
  SigningStargateClient,
} from '@cosmjs/stargate';
import { describe, expect, it, vi } from 'vitest';
import {
  makeMockConfig,
  makeMockQueryClient,
  makeSealedClientManager,
  makeTxCtx,
} from '../__test-utils__/mocks.js';
import { parseLeaseUuid } from '../brands.js';
import { LeaseState } from '../manifest-types.js';
import { jsonResponse } from '../server-utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { stopApp } from './stopApp.js';

const LEASE = parseLeaseUuid('550e8400-e29b-41d4-a716-446655440000');
const ADDRESS = toBech32('manifest', new Uint8Array(20).fill(1));
const HASH = 'aB'.repeat(32);

const FAILED_TX = {
  code: 11,
  transactionHash: HASH,
  height: 42,
  txIndex: 0,
  gasUsed: 100n,
  gasWanted: 100n,
  events: [],
  msgResponses: [],
  rawLog: 'untrusted provider diagnostic '.repeat(10_000),
} satisfies DeliverTxResponse;

/** Real stopApp → cosmosTx → billing handler, with only client-manager/wire seams replaced. */
function fixture(
  initial = LeaseState.LEASE_STATE_ACTIVE,
  terminal = LeaseState.LEASE_STATE_CLOSED,
) {
  const query = makeMockQueryClient();
  const lease = vi
    .fn()
    .mockResolvedValueOnce({ lease: { uuid: LEASE, state: initial } })
    .mockResolvedValue({ lease: { uuid: LEASE, state: terminal } });
  query.liftedinit.billing.v1.lease = lease;
  const simulate = vi.fn<SigningStargateClient['simulate']>(async () => 100);
  const broadcast = vi.fn<SigningStargateClient['signAndBroadcast']>(
    async () => FAILED_TX,
  );
  const sync = vi.fn<SigningStargateClient['signAndBroadcastSync']>();
  // The signing wire intentionally implements only methods exercised by the real billing handler.
  const wire = {
    simulate,
    signAndBroadcast: broadcast,
    signAndBroadcastSync: sync,
  } as unknown as SigningStargateClient;
  const chain = makeSealedClientManager({
    getQueryClient: vi.fn(async () => query),
    getConfig: vi.fn(() => makeMockConfig({ retry: { maxRetries: 0 } })),
    getAddress: vi.fn(async () => ADDRESS),
    getBroadcastClient: vi.fn(async () => wire),
    acquireRateLimit: vi.fn(async () => undefined),
    withBroadcastLock: async (_address, action) => action(),
  });
  return { ctx: makeTxCtx({ chain }), lease, simulate, broadcast, sync };
}

describe('stopApp reconciliation through the real transaction pipeline', () => {
  it.each([
    {
      initial: LeaseState.LEASE_STATE_ACTIVE,
      terminal: LeaseState.LEASE_STATE_CLOSED,
      command: 'MsgCloseLease',
    },
    {
      initial: LeaseState.LEASE_STATE_PENDING,
      terminal: LeaseState.LEASE_STATE_REJECTED,
      command: 'MsgCancelLease',
    },
  ])(
    'retains the failed $command receipt separately from the terminal observation',
    async ({ initial, terminal, command }) => {
      const f = fixture(initial, terminal);
      const result = await stopApp(f.ctx, { leaseUuid: LEASE });
      expect(result.outcome).toBe('already_inactive');
      if (result.outcome !== 'already_inactive')
        throw new Error('expected terminal reconciliation');
      expect(result.reconciliation).toEqual({
        errorCode: ManifestMCPErrorCode.TX_FAILED,
        sent: true,
        transactionHash: HASH,
        transactionCode: 11,
        transactionHeight: '42',
        transactionConfirmed: true,
      });
      const original = result.reconciliation?.error;
      expect(original).toBeInstanceOf(ManifestMCPError);
      expect(original).toMatchObject({
        details: {
          transactionHash: HASH,
          sent: true,
          confirmed: true,
          rawLog: FAILED_TX.rawLog,
        },
      });
      expect(Object.isFrozen(result.reconciliation)).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(result.reconciliation, 'error'),
      ).toMatchObject({ value: original, enumerable: false, writable: false });
      expect(Object.isFrozen(original)).toBe(false);
      expect(f.lease).toHaveBeenCalledTimes(2);
      expect(f.simulate).toHaveBeenCalledOnce();
      expect(f.broadcast).toHaveBeenCalledOnce();
      expect(f.broadcast.mock.calls[0]?.[1][0]?.typeUrl).toBe(
        `/liftedinit.billing.v1.${command}`,
      );
      expect(f.sync).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('transactionHash');

      const response = jsonResponse(result);
      expect(JSON.stringify(response)).not.toContain(
        'untrusted provider diagnostic',
      );
      expect(JSON.stringify(response)).toContain(HASH);
      expect(JSON.stringify(result).length).toBeLessThan(700);
    },
  );

  it('preserves a frozen preparation error without claiming a transaction was submitted', async () => {
    const f = fixture();
    const original = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
        'simulation exceeds configured gas ceiling',
        Object.freeze({ module: 'billing', maxGas: 1 }),
      ),
    );
    f.simulate.mockRejectedValue(original);
    const result = await stopApp(f.ctx, { leaseUuid: LEASE });
    if (result.outcome !== 'already_inactive')
      throw new Error('expected terminal reconciliation');
    expect(result.reconciliation).toEqual({ errorCode: original.code });
    expect(result.reconciliation?.error).toBe(original);
    expect(result.reconciliation).not.toHaveProperty('sent');
    expect(result.reconciliation).not.toHaveProperty('transactionHash');
    expect(original.details).toEqual({ module: 'billing', maxGas: 1 });
    expect(f.lease).toHaveBeenCalledTimes(2);
    expect(f.simulate).toHaveBeenCalledOnce();
    expect(f.broadcast).not.toHaveBeenCalled();
  });

  it('does not infer submission or confirmation from a raw broadcast rejection without a receipt', async () => {
    const f = fixture();
    f.broadcast.mockRejectedValue(
      new Error('connection lost while awaiting broadcast'),
    );
    const result = await stopApp(f.ctx, { leaseUuid: LEASE });
    if (result.outcome !== 'already_inactive')
      throw new Error('expected terminal reconciliation');
    expect(result.reconciliation).toEqual({
      errorCode: ManifestMCPErrorCode.TX_FAILED,
    });
    expect(result.reconciliation?.error).toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
    });
    expect(result.reconciliation).not.toHaveProperty('sent');
    expect(result.reconciliation).not.toHaveProperty('transactionConfirmed');
    expect(f.broadcast).toHaveBeenCalledOnce();
  });

  it('keeps terminal pre-query success free of reconciliation metadata', async () => {
    const f = fixture(LeaseState.LEASE_STATE_CLOSED);
    const result = await stopApp(f.ctx, { leaseUuid: LEASE });
    expect(result).toEqual({
      lease_uuid: LEASE,
      outcome: 'already_inactive',
      lease_state: 'LEASE_STATE_CLOSED',
    });
    expect(f.lease).toHaveBeenCalledOnce();
    expect(f.simulate).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
  });
});
