import { type SigningStargateClient, TimeoutError } from '@cosmjs/stargate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expectExactDetails,
  makeInclusionTimeoutFixture,
  makeMockConfig,
  makeSealedClientManager,
  makeTxCtx,
} from './__test-utils__/mocks.js';
import { cosmosTx } from './cosmos.js';
import { isOwnedBroadcastFailure } from './internals/broadcast-failure.js';
import {
  type SequenceCache,
  sequencedSigningClient,
} from './internals/tx-sequence.js';
import type { TxCallOptions } from './options.js';
import { withRetry } from './retry.js';
import { executeTx } from './tools/executeTx.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

type EntryPoint = 'cosmosTx' | 'executeTx';

async function fixture(entryPoint: EntryPoint, guarded = true) {
  const wire = await makeInclusionTimeoutFixture();
  if (guarded) wire.installGuard();
  let broadcastError: unknown;
  const originalBroadcast = wire.client.signAndBroadcast;
  vi.spyOn(wire.client, 'signAndBroadcast').mockImplementation(async function (
    this: SigningStargateClient,
    ...args
  ) {
    try {
      return await originalBroadcast.apply(this, args);
    } catch (error) {
      broadcastError = error;
      throw error;
    }
  });
  const config = makeMockConfig({
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
  });
  const getAddress = vi.fn(async () => wire.sender);
  const chain = makeSealedClientManager({
    getConfig: vi.fn(() => config),
    getAddress,
    getBroadcastClient: vi.fn(async () => wire.client),
    acquireRateLimit: vi.fn(async () => undefined),
    withBroadcastLock: async (_sender, action) => action(),
  });
  const ctx = makeTxCtx({ chain });
  const args = [wire.sender, '1umfx'];
  const invoke = async (options: TxCallOptions = {}) =>
    entryPoint === 'cosmosTx'
      ? cosmosTx(
          chain,
          'bank',
          'send',
          args,
          options.waitForConfirmation ?? true,
          undefined,
          { fee: wire.fee },
          options,
        )
      : executeTx(ctx, wire.messages, { ...options, fee: wire.fee });
  return {
    ...wire,
    chain,
    invoke,
    getAddress,
    broadcastError: () => broadcastError,
    context:
      entryPoint === 'cosmosTx'
        ? { module: 'bank', subcommand: 'send', args }
        : { msgTypeUrls: wire.messages.map((message) => message.typeUrl) },
  };
}

function ownCause(error: unknown): unknown {
  return error instanceof Error
    ? Object.getOwnPropertyDescriptor(error, 'cause')?.value
    : undefined;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('cosmosTx composes the active-signal guard, cached sequence and owned broadcast failure', async () => {
  const f = await fixture('cosmosTx');
  const committedSequence = vi
    .spyOn(f.client, 'getSequence')
    .mockResolvedValue({ accountNumber: 1, sequence: 5 });
  const signedSequences: number[] = [];
  f.sign.mockImplementation(async function (this: SigningStargateClient) {
    signedSequences.push((await this.getSequence(f.sender)).sequence);
    return {
      bodyBytes: new Uint8Array(),
      authInfoBytes: new Uint8Array(),
      signatures: [],
    };
  });
  const cache: SequenceCache = new Map([
    [f.sender, { accountNumber: 1, sequence: 8 }],
  ]);
  vi.spyOn(f.chain, 'getBroadcastClient').mockResolvedValue(
    sequencedSigningClient(f.client, cache),
  );
  // Supplying a live signal activates cosmosTx's outer guardTxClient proxy.
  // The seeded cache then requires the sequencer's receiver view underneath it.
  const controller = new AbortController();
  const operation = vi.fn(() => f.invoke({ signal: controller.signal }));
  const retry = vi.fn();
  const pending = withRetry(operation, {
    config: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
    onRetry: retry,
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(20);
  const error = await pending;

  expect(f.chain.acquireRateLimit).toHaveBeenCalledExactlyOnceWith(
    controller.signal,
  );
  expect(signedSequences).toEqual([8]);
  expect(committedSequence).not.toHaveBeenCalled();
  expect(cache.has(f.sender)).toBe(false);
  expect(error).toBeInstanceOf(ManifestMCPError);
  if (!(error instanceof ManifestMCPError))
    throw new Error('expected attributed broadcast failure');
  expect(error.code).toBe(ManifestMCPErrorCode.TX_FAILED);
  expectExactDetails(error, {
    sent: true,
    transactionHash: f.hash,
    ...f.context,
  });
  const owned = ownCause(error);
  expect(owned).toBe(f.broadcastError());
  expect(isOwnedBroadcastFailure(owned)).toBe(true);
  expectExactDetails(owned, { sent: true, transactionHash: f.hash });
  expect(ownCause(owned)).toBeInstanceOf(TimeoutError);
  expect(ownCause(owned)).toMatchObject({ txId: f.hash });
  expect(Object.getOwnPropertyDescriptor(error, 'cause')).toMatchObject({
    enumerable: false,
  });
  expect(operation).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(f.sign).toHaveBeenCalledOnce();
  expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
  expect(f.comet.txSearchAll).toHaveBeenCalledExactlyOnceWith({
    query: `tx.hash='${f.hash}'`,
  });
});

describe.each<EntryPoint>(['cosmosTx', 'executeTx'])(
  '%s inclusion-timeout attribution',
  (entryPoint) => {
    it('retains accepted submission and the original timeout without retrying or inferring inclusion', async () => {
      const f = await fixture(entryPoint);
      const retry = vi.fn();
      let calls = 0;
      const result = withRetry(
        () => {
          calls += 1;
          return f.invoke();
        },
        {
          config: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
          onRetry: retry,
        },
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      const error = await result;
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.TX_FAILED,
        message: expect.stringContaining(
          entryPoint === 'cosmosTx' ? 'Tx bank send failed:' : 'executeTx (',
        ),
      });
      expectExactDetails(error, {
        sent: true,
        transactionHash: f.hash,
        ...f.context,
      });
      expectExactDetails(f.broadcastError(), {
        sent: true,
        transactionHash: f.hash,
      });
      expect(ownCause(error)).toBe(f.broadcastError());
      const timeout = ownCause(f.broadcastError());
      expect(timeout).toBeInstanceOf(TimeoutError);
      expect(timeout).toMatchObject({ txId: f.hash });
      expect(Object.getOwnPropertyDescriptor(error, 'cause')).toMatchObject({
        enumerable: false,
      });
      expect(calls).toBe(1);
      expect(retry).not.toHaveBeenCalled();
      expect(f.sign).toHaveBeenCalledOnce();
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
      expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
    });

    it('does not infer evidence from an unguarded native timeout', async () => {
      const f = await fixture(entryPoint, false);
      const result = f.invoke().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      const error = await result;
      expect(error).toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
      expectExactDetails(error, f.context);
      expect(f.broadcastError()).toBeInstanceOf(TimeoutError);
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
    });

    it('uses observed acceptance when a later lookup fails, ignoring claimed transaction metadata', async () => {
      const f = await fixture(entryPoint);
      const lookupError = Object.freeze(
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'RPC unavailable',
          {
            transactionHash: 'FF'.repeat(32),
            confirmed: true,
            code: 0,
            height: '999',
            transactionConfirmed: true,
            transactionCode: 0,
            transactionHeight: '999',
          },
        ),
      );
      f.comet.txSearchAll.mockRejectedValue(lookupError);
      const result = f.invoke().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      const error = await result;
      expect(error).toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
      expectExactDetails(error, {
        sent: true,
        transactionHash: f.hash,
        ...f.context,
      });
      expectExactDetails(f.broadcastError(), {
        sent: true,
        transactionHash: f.hash,
      });
      expect(ownCause(error)).toBe(f.broadcastError());
      expect(ownCause(f.broadcastError())).toBe(lookupError);
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
      expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
    });

    it('keeps an injected lookup cancellation terminal after accepted submission', async () => {
      const f = await fixture(entryPoint);
      const cancellation = new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
        'Lookup cancelled',
      );
      // This custom lookup rejection has no caller signal; the separate real
      // caller-abort regression below exercises withTxExecution's abort race.
      f.comet.txSearchAll.mockRejectedValue(cancellation);
      const result = f.invoke().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      const error = await result;
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      expectExactDetails(error, {
        sent: true,
        transactionHash: f.hash,
        ...f.context,
      });
      expectExactDetails(f.broadcastError(), {
        sent: true,
        transactionHash: f.hash,
      });
      expect(ownCause(f.broadcastError())).toBe(cancellation);
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
    });

    it.each(['revoked proxy', 'throwing cause getter'])(
      'retains the submission envelope when the lookup rejects with a hostile %s',
      async (kind) => {
        const f = await fixture(entryPoint);
        let hostile: unknown;
        if (kind === 'revoked proxy') {
          const { proxy, revoke } = Proxy.revocable(
            new Error('Lookup failed'),
            {},
          );
          revoke();
          hostile = proxy;
        } else {
          hostile = Object.defineProperty(new Error('Lookup failed'), 'cause', {
            get() {
              throw new Error('Diagnostic cause must not be inspected');
            },
          });
        }
        f.comet.txSearchAll.mockRejectedValue(hostile);
        const result = f.invoke().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(20);
        const error = await result;
        expect(error).toBeInstanceOf(ManifestMCPError);
        expectExactDetails(error, {
          sent: true,
          transactionHash: f.hash,
          ...f.context,
        });
        expectExactDetails(ownCause(error), {
          sent: true,
          transactionHash: f.hash,
        });
        expect(ownCause(ownCause(error))).toBe(hostile);
        expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
      },
    );

    it('does not promote a forged timeout rejected during signing', async () => {
      const f = await fixture(entryPoint);
      const forged = new TimeoutError('Transaction was submitted', f.hash);
      f.sign.mockRejectedValue(forged);
      const result = f.invoke().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      const error = await result;
      expect(error).toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
      expectExactDetails(error, f.context);
      expect(f.broadcastError()).toBe(forged);
      expect(f.sign).toHaveBeenCalledOnce();
      expect(f.comet.broadcastTxSync).not.toHaveBeenCalled();
    });

    it('keeps the SYNC result hash-only and never polls', async () => {
      const f = await fixture(entryPoint);
      const result = await f.invoke({ waitForConfirmation: false });
      expect(result).toMatchObject({
        transactionHash: f.hash,
        confirmed: false,
        code: 0,
        height: '',
      });
      expect(result).not.toHaveProperty('reconciliation');
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
      expect(f.comet.txSearchAll).not.toHaveBeenCalled();
    });

    it('preserves caller cancellation after submission without substituting the later inclusion timeout', async () => {
      const f = await fixture(entryPoint);
      const abort = new AbortController();
      f.comet.txSearchAll.mockImplementation(async () => {
        abort.abort(new Error('Caller stopped waiting'));
        return { txs: [], totalCount: 0 };
      });
      const result = f
        .invoke({ signal: abort.signal })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      const error = await result;
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
        details: { sent: true, reason: abort.signal.reason },
      });
      expect(error).not.toHaveProperty('details.transactionHash');
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
    });

    it('prevents signing for a pre-cancelled call', async () => {
      const f = await fixture(entryPoint);
      const abort = new AbortController();
      abort.abort();
      await expect(f.invoke({ signal: abort.signal })).rejects.toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
        details: { sent: false },
      });
      expect(f.getAddress).not.toHaveBeenCalled();
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.comet.broadcastTxSync).not.toHaveBeenCalled();
    });
  },
);
