import type { EncodeObject } from '@cosmjs/proto-signing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMockClientManager, makeTxCtx } from '../__test-utils__/mocks.js';
import type { TxCtx } from '../ctx.js';
import { ManifestMCPErrorCode } from '../types.js';
import { executeTx } from './executeTx.js';

const msgs: EncodeObject[] = [
  { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: {} },
];

function okResult(overrides?: Record<string, unknown>) {
  return {
    code: 0,
    transactionHash: 'HASH',
    height: 42,
    gasUsed: 1n,
    gasWanted: 2n,
    events: [],
    rawLog: '',
    ...overrides,
  };
}

/**
 * Build a TxCtx whose chain returns a fake signing client with the given signAndBroadcast/simulate.
 * There is NO makeChainWith — override getSigningClient inline.
 */
function ctxWith(
  signAndBroadcast: ReturnType<typeof vi.fn>,
  simulate: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(100_000),
): TxCtx {
  const chain = makeMockClientManager();
  chain.getSigningClient = vi
    .fn()
    .mockResolvedValue({ signAndBroadcast, simulate });
  return makeTxCtx({ chain });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('executeTx', () => {
  it('broadcasts multi-msg and returns a label-free result with height + msgTypeUrls', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const res = await executeTx(ctxWith(signAndBroadcast), msgs);
    expect(res).toMatchObject({
      transactionHash: 'HASH',
      height: '42',
      code: 0,
      msgTypeUrls: ['/cosmos.bank.v1beta1.MsgSend'],
    });
    expect(res.height).toBe('42'); // committed DeliverTxResponse height, never a sync hash
    expect(res).not.toHaveProperty('module');
    expect(res).not.toHaveProperty('subcommand');
    expect(signAndBroadcast).toHaveBeenCalledWith(
      expect.any(String),
      msgs,
      expect.anything(),
      '',
    );
  });

  it('waitForConfirmation=false → SYNC broadcast (signAndBroadcastSync), hash-only unconfirmed result', async () => {
    const signAndBroadcast = vi.fn();
    const signAndBroadcastSync = vi.fn().mockResolvedValue('SYNCHASH');
    const chain = makeMockClientManager();
    chain.getSigningClient = vi.fn().mockResolvedValue({
      signAndBroadcast,
      signAndBroadcastSync,
      simulate: vi.fn().mockResolvedValue(100_000),
    });

    const res = await executeTx(makeTxCtx({ chain }), msgs, {
      waitForConfirmation: false,
    });

    expect(signAndBroadcastSync).toHaveBeenCalledOnce();
    // Same (sender, messages, fee, memo) threading as the blocking path (no fee/memo swap on sync).
    expect(signAndBroadcastSync).toHaveBeenCalledWith(
      expect.any(String),
      msgs,
      'auto',
      '',
    );
    expect(signAndBroadcast).not.toHaveBeenCalled();
    expect(res).toEqual({
      transactionHash: 'SYNCHASH',
      code: 0,
      height: '',
      confirmed: false,
      msgTypeUrls: ['/cosmos.bank.v1beta1.MsgSend'],
    });
  });

  it('passes opts.fee straight to signAndBroadcast and never simulates (fee-wins)', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(100_000);
    const fee = { amount: [{ denom: 'umfx', amount: '5' }], gas: '200000' };
    await executeTx(ctxWith(signAndBroadcast, simulate), msgs, { fee });
    expect(simulate).not.toHaveBeenCalled();
    expect(signAndBroadcast).toHaveBeenCalledWith(
      expect.any(String),
      msgs,
      fee,
      '',
    );
  });

  it('drives the simulate path when opts.gasMultiplier is set', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(100_000);
    await executeTx(ctxWith(signAndBroadcast, simulate), msgs, {
      gasMultiplier: 2,
    });
    expect(simulate).toHaveBeenCalledTimes(1);
    // computed fee (not 'auto') reaches signAndBroadcast
    const feeArg = signAndBroadcast.mock.calls[0][2];
    expect(feeArg).not.toBe('auto');
    expect(feeArg).toMatchObject({ gas: expect.any(String) });
  });

  it('rejects fee + gasMultiplier with INVALID_CONFIG', async () => {
    await expect(
      executeTx(makeTxCtx(), msgs, {
        fee: { amount: [], gas: '1' },
        gasMultiplier: 1.5,
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
  });

  it('rejects empty messages with INVALID_ARGUMENT', async () => {
    await expect(executeTx(makeTxCtx(), [])).rejects.toMatchObject({
      code: ManifestMCPErrorCode.INVALID_ARGUMENT,
    });
  });

  it('throws TX_FAILED naming the msgTypeUrls on a non-zero code', async () => {
    const signAndBroadcast = vi
      .fn()
      .mockResolvedValue(okResult({ code: 5, rawLog: 'insufficient funds' }));
    await expect(
      executeTx(ctxWith(signAndBroadcast), msgs),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      message: expect.stringContaining('/cosmos.bank.v1beta1.MsgSend'),
    });
  });

  it('serializes two concurrent executeTx from the same ctx.chain (real lock)', async () => {
    const order: string[] = [];
    let resolveFirst: () => void = () => {};
    const signAndBroadcast = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            order.push('a-start');
            resolveFirst = () => {
              order.push('a-end');
              resolve(okResult());
            };
          }),
      )
      .mockImplementationOnce(async () => {
        order.push('b-run');
        return okResult();
      });

    const chain = makeMockClientManager();
    chain.getSigningClient = vi
      .fn()
      .mockResolvedValue({ signAndBroadcast, simulate: vi.fn() });
    // REAL serializing lock (the passthrough mock would NOT prove serialization).
    const locks = new Map<string, Promise<unknown>>();
    chain.withBroadcastLock = (<T>(
      address: string,
      fn: () => Promise<T>,
    ): Promise<T> => {
      const prev = locks.get(address) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      locks.set(
        address,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      return run;
    }) as typeof chain.withBroadcastLock;
    const ctx = makeTxCtx({ chain });

    const p1 = executeTx(ctx, msgs);
    const p2 = executeTx(ctx, msgs);
    // Let the first broadcast register before releasing it.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['a-start']); // b has NOT started — it waits for a
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-run']);
  });

  it('does NOT re-broadcast on a raw transient broadcast error (no double-broadcast)', async () => {
    const signAndBroadcast = vi
      .fn()
      .mockRejectedValue(new Error('socket hang up')); // transient MESSAGE
    await expect(
      executeTx(ctxWith(signAndBroadcast), msgs),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
    // wrapped to TX_FAILED ⇒ NON_RETRYABLE ⇒ sent exactly once
    expect(signAndBroadcast).toHaveBeenCalledTimes(1);
  });
});
