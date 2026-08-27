import type { EncodeObject } from '@cosmjs/proto-signing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeMockClientManager,
  makeMockConfig,
  makeTxCtx,
} from '../__test-utils__/mocks.js';
import type { TxCtx } from '../ctx.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
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
  return makeTxCtx({ chain: chainWith(signAndBroadcast, simulate) });
}

function chainWith(
  signAndBroadcast: ReturnType<typeof vi.fn>,
  simulate: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(100_000),
  config: ReturnType<typeof makeMockConfig> = makeMockConfig(),
) {
  const chain = makeMockClientManager({ config });
  chain.getSigningClient = vi
    .fn()
    .mockResolvedValue({ signAndBroadcast, simulate });
  return chain;
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
      expect.objectContaining({ gas: expect.any(String) }),
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

  it('rejects an explicit fee above config.maxGas before signing', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(100_000);
    const chain = chainWith(
      signAndBroadcast,
      simulate,
      makeMockConfig({ maxGas: 50_000_000 }),
    );

    await expect(
      executeTx(makeTxCtx({ chain }), msgs, {
        fee: {
          amount: [{ denom: 'umfx', amount: '1' }],
          gas: '999999999999',
        },
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
    });

    expect(chain.getBroadcastClient).not.toHaveBeenCalled();
    expect(signAndBroadcast).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });

  it('applies DEFAULT_MAX_GAS when config.maxGas is omitted', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(100_000);
    const chain = chainWith(signAndBroadcast, simulate);
    expect(chain.getConfig().maxGas).toBeUndefined();

    await expect(
      executeTx(makeTxCtx({ chain }), msgs, {
        fee: {
          amount: [{ denom: 'umfx', amount: '1' }],
          gas: '60000000',
        },
      }),
    ).rejects.toMatchObject({
      code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
    });

    expect(chain.getBroadcastClient).not.toHaveBeenCalled();
    expect(signAndBroadcast).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });

  it('rejects a malformed config.maxGas instead of failing open', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const chain = chainWith(
      signAndBroadcast,
      undefined,
      makeMockConfig({ maxGas: 0 }),
    );

    await expect(
      executeTx(makeTxCtx({ chain }), msgs, {
        fee: { amount: [], gas: '200000' },
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });

    expect(chain.getBroadcastClient).not.toHaveBeenCalled();
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it('classifies a null fee from an untyped caller before signing', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const chain = chainWith(signAndBroadcast);

    await expect(
      executeTx(makeTxCtx({ chain }), msgs, { fee: null as never }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });

    expect(chain.getBroadcastClient).not.toHaveBeenCalled();
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it('allows an explicit fee above the default ceiling when maxGas is -1', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(100_000);
    const chain = chainWith(
      signAndBroadcast,
      simulate,
      makeMockConfig({ maxGas: -1 }),
    );
    const fee = {
      amount: [{ denom: 'umfx', amount: '1' }],
      gas: '999999999999',
    };

    await executeTx(makeTxCtx({ chain }), msgs, { fee });

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

  it('aborts with GAS_LIMIT_EXCEEDED when the simulated gas exceeds config.maxGas', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(40_000_000); // * 1.5 default = 60M > 50M
    const ctx = ctxWith(signAndBroadcast, simulate);

    await expect(executeTx(ctx, msgs)).rejects.toMatchObject({
      code: ManifestMCPErrorCode.GAS_LIMIT_EXCEEDED,
    });
    expect(signAndBroadcast).not.toHaveBeenCalled();
  });

  it('drives the simulate path on the default call (no opts) and stays under the ceiling', async () => {
    const signAndBroadcast = vi.fn().mockResolvedValue(okResult());
    const simulate = vi.fn().mockResolvedValue(100_000);
    const ctx = ctxWith(signAndBroadcast, simulate);

    await executeTx(ctx, msgs);

    expect(simulate).toHaveBeenCalledTimes(1);
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
    chain.getSigningClient = vi.fn().mockResolvedValue({
      signAndBroadcast,
      simulate: vi.fn().mockResolvedValue(100_000),
    });
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

  // ENG-679 — getBroadcastClient/getSigningClient retry the connect internally; acquiring
  // one inside executeTx's own ladder multiplied attempts (4 outer x 4 inner x 5 namespace
  // clients = 77 connects on a dead endpoint). These run the REAL withRetry (this file never
  // mocks ./retry.js) with a ~1ms backoff, so a re-nested acquisition shows up as 4 calls.
  describe('client acquisition is outside the retry ladder (ENG-679)', () => {
    const FAST_RETRY = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 };
    const ATTEMPTS = FAST_RETRY.maxRetries + 1;

    it('acquires the broadcast client ONCE while the broadcast leg still retries', async () => {
      // A ManifestMCPError with a transient message passes through the catch unwrapped and
      // stays retryable — a RAW throw would become the non-retryable TX_FAILED and prove nothing.
      const simulate = vi
        .fn()
        .mockRejectedValue(
          new ManifestMCPError(
            ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
            'fetch failed',
          ),
        );
      const chain = makeMockClientManager({
        config: makeMockConfig({ retry: FAST_RETRY }),
      });
      chain.getSigningClient = vi
        .fn()
        .mockResolvedValue({ signAndBroadcast: vi.fn(), simulate });

      await expect(executeTx(makeTxCtx({ chain }), msgs)).rejects.toMatchObject(
        {
          code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        },
      );

      expect(chain.getBroadcastClient).toHaveBeenCalledTimes(1);
      expect(simulate).toHaveBeenCalledTimes(ATTEMPTS);
      expect(chain.acquireRateLimit).toHaveBeenCalledTimes(ATTEMPTS);
    });

    it('does not re-run a failed acquisition', async () => {
      const chain = makeMockClientManager({
        config: makeMockConfig({ retry: FAST_RETRY }),
      });
      chain.getBroadcastClient = vi
        .fn()
        .mockRejectedValue(
          new ManifestMCPError(
            ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
            'Failed to connect signing client: fetch failed',
          ),
        );

      await expect(executeTx(makeTxCtx({ chain }), msgs)).rejects.toMatchObject(
        {
          code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        },
      );

      expect(chain.getBroadcastClient).toHaveBeenCalledTimes(1);
    });
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
