import { createHash } from 'node:crypto';
import { SigningStargateClient, TimeoutError } from '@cosmjs/stargate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deferred,
  expectExactDetails,
  makeInclusionTimeoutFixture,
  makeMockConfig,
  makeSealedClientManager,
  makeTxCtx,
} from './__test-utils__/mocks.js';
import { CosmosClientManager } from './client.js';
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

type FixtureOptions = {
  readonly captureBroadcastError?: boolean;
} & (
  | { readonly guarded?: true; readonly realManager?: boolean }
  | { readonly guarded: false; readonly realManager?: false }
);

async function fixture(
  entryPoint: EntryPoint,
  {
    guarded = true,
    captureBroadcastError = false,
    realManager = false,
  }: FixtureOptions = {},
) {
  if (!guarded && realManager)
    throw new Error('A real manager always installs the broadcast guard');
  const wire = await makeInclusionTimeoutFixture();
  if (guarded && !realManager) wire.installGuard();
  let broadcastError: unknown;
  const originalBroadcast = wire.client.signAndBroadcast;
  if (captureBroadcastError)
    vi.spyOn(wire.client, 'signAndBroadcast').mockImplementation(
      async function (this: SigningStargateClient, ...args) {
        try {
          return await originalBroadcast.apply(this, args);
        } catch (error) {
          broadcastError = error;
          throw error;
        }
      },
    );
  const config = makeMockConfig({
    retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
  });
  const getAddress = vi.fn(async () => wire.sender);
  const cache: SequenceCache = new Map();
  let chain: CosmosClientManager;
  if (realManager) {
    vi.spyOn(SigningStargateClient, 'connectWithSigner').mockResolvedValue(
      wire.client,
    );
    chain = CosmosClientManager.getInstance(config, {
      getAddress,
      getSigner: async () => wire.signer,
    });
  } else {
    chain = makeSealedClientManager({
      getConfig: vi.fn(() => config),
      getAddress,
      getBroadcastClient: vi.fn(async (onAccepted?: (hash: string) => void) =>
        sequencedSigningClient(wire.client, cache, onAccepted),
      ),
      acquireRateLimit: vi.fn(async () => undefined),
      withBroadcastLock: async (_sender, action) => action(),
    });
  }
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
    cache,
    invoke,
    getAddress,
    broadcastError: () => broadcastError,
    context:
      entryPoint === 'cosmosTx'
        ? { module: 'bank', subcommand: 'send', args }
        : { msgTypeUrls: wire.messages.map((message) => message.typeUrl) },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type PollResult = Awaited<ReturnType<Fixture['comet']['txSearchAll']>>;

function submittedHash(f: Fixture): string {
  return createHash('sha256')
    .update(f.comet.broadcastTxSync.mock.calls[0][0].tx)
    .digest('hex')
    .toUpperCase();
}

function cancellableAttempt(f: Fixture, signal: AbortSignal) {
  const operation = vi.fn(() => f.invoke({ signal }));
  const retry = vi.fn();
  const settled = vi.fn();
  const pending = withRetry(operation, {
    config: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
    onRetry: retry,
  }).catch((error: unknown) => error);
  void pending.then(settled);
  return { pending, operation, retry, settled };
}

function ownCause(error: unknown): unknown {
  return error instanceof Error
    ? Object.getOwnPropertyDescriptor(error, 'cause')?.value
    : undefined;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  try {
    CosmosClientManager.clearInstances();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it('cosmosTx composes the active-signal guard, cached sequence and owned broadcast failure', async () => {
  const f = await fixture('cosmosTx', { captureBroadcastError: true });
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
      const f = await fixture(entryPoint, { captureBroadcastError: true });
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
      const f = await fixture(entryPoint, {
        guarded: false,
        captureBroadcastError: true,
      });
      const result = f.invoke().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20);
      const error = await result;
      expect(error).toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
      expectExactDetails(error, f.context);
      expect(f.broadcastError()).toBeInstanceOf(TimeoutError);
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
    });

    it('uses observed acceptance when a later lookup fails, ignoring claimed transaction metadata', async () => {
      const f = await fixture(entryPoint, { captureBroadcastError: true });
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
      const f = await fixture(entryPoint, { captureBroadcastError: true });
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
      const f = await fixture(entryPoint, { captureBroadcastError: true });
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
      vi.spyOn(f.client, 'getSequence').mockResolvedValue({
        accountNumber: 1,
        sequence: 5,
      });
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

    it('preserves caller cancellation and known identity without substituting the later inclusion timeout', async () => {
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
      expectExactDetails(error, {
        reason: abort.signal.reason,
        sent: true,
        transactionHash: f.hash,
      });
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
    });

    it('prevents signing for a pre-cancelled call', async () => {
      const f = await fixture(entryPoint);
      const abort = new AbortController();
      abort.abort();
      const error = await f
        .invoke({ signal: abort.signal })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      });
      expectExactDetails(error, { reason: abort.signal.reason, sent: false });
      expect(f.getAddress).not.toHaveBeenCalled();
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.comet.broadcastTxSync).not.toHaveBeenCalled();
    });
  },
);

describe.each<EntryPoint>(['cosmosTx', 'executeTx'])(
  '%s caller cancellation retains only already-observed acceptance',
  (entryPoint) => {
    it.each(['success', 'failure'] as const)(
      'settles before native polling and keeps its evidence after late %s',
      async (lateOutcome) => {
        // The failure case proves actual manager→sequencer argument forwarding;
        // the success case also requires the cached-sequence receiver view.
        const realManager = lateOutcome === 'failure';
        const f = await fixture(entryPoint, { realManager });
        const sequences: number[] = [];
        if (!realManager) {
          f.cache.set(f.sender, { accountNumber: 1, sequence: 8 });
          f.sign.mockImplementation(async function (
            this: SigningStargateClient,
          ) {
            sequences.push((await this.getSequence(f.sender)).sequence);
            return {
              bodyBytes: new Uint8Array(),
              authInfoBytes: new Uint8Array(),
              signatures: [],
            };
          });
        }
        const poll = deferred<PollResult>();
        f.comet.txSearchAll.mockReturnValue(poll.promise);
        const abort = new AbortController();
        const reason = Object.freeze(new Error('Caller stopped waiting'));
        const attempt = cancellableAttempt(f, abort.signal);
        try {
          await vi.advanceTimersByTimeAsync(2);
          expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
          expect(attempt.settled).not.toHaveBeenCalled();
          abort.abort(reason);
          await vi.advanceTimersByTimeAsync(0);
          expect(attempt.settled).toHaveBeenCalledOnce();
          const error = await attempt.pending;
          expect(error).toMatchObject({
            code: ManifestMCPErrorCode.OPERATION_CANCELLED,
          });
          const details = {
            reason,
            sent: true,
            transactionHash: submittedHash(f),
          };
          expectExactDetails(error, details);
          if (!(error instanceof ManifestMCPError))
            throw new Error('expected caller cancellation');
          const originalDetails = error.details;
          expect(error.details?.reason).toBe(reason);
          if (realManager) {
            expect(
              SigningStargateClient.connectWithSigner,
            ).toHaveBeenCalledOnce();
            expect(f.comet.status).toHaveBeenCalledOnce();
          } else {
            expect(sequences).toEqual([8]);
          }

          if (lateOutcome === 'failure') {
            poll.reject(new Error('Late polling failure'));
          } else {
            poll.resolve({
              txs: [
                {
                  height: 7,
                  hash: f.checkTx.hash,
                  index: 0,
                  tx: new Uint8Array(),
                  result: { code: 0, events: [], gasUsed: 10n, gasWanted: 20n },
                },
              ],
              totalCount: 1,
            });
          }
          await vi.advanceTimersByTimeAsync(10);
          expect(await attempt.pending).toBe(error);
          expect(error.details).toBe(originalDetails);
          expectExactDetails(error, details);
          expect(attempt.settled).toHaveBeenCalledOnce();
          expect(attempt.operation).toHaveBeenCalledOnce();
          expect(attempt.retry).not.toHaveBeenCalled();
          expect(f.sign).toHaveBeenCalledOnce();
          expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          poll.resolve({ txs: [], totalCount: 0 });
          await vi.advanceTimersByTimeAsync(10);
        }
      },
    );

    it('does not retroactively add a hash when cancellation precedes the CheckTx response', async () => {
      const f = await fixture(entryPoint);
      const checkTx = deferred<typeof f.checkTx>();
      f.comet.broadcastTxSync.mockReturnValue(checkTx.promise);
      const abort = new AbortController();
      const reason = new Error('Cancelled while awaiting CheckTx');
      const attempt = cancellableAttempt(f, abort.signal);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
        abort.abort(reason);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt.settled).toHaveBeenCalledOnce();
        const error = await attempt.pending;
        expectExactDetails(error, { reason, sent: true });
        checkTx.resolve(f.checkTx);
        await vi.advanceTimersByTimeAsync(10);
        expectExactDetails(error, { reason, sent: true });
        expect(await attempt.pending).toBe(error);
        expect(attempt.operation).toHaveBeenCalledOnce();
        expect(attempt.retry).not.toHaveBeenCalled();
        expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        checkTx.resolve(f.checkTx);
        await vi.advanceTimersByTimeAsync(10);
      }
    });

    it.each([31, 32])(
      'retains the local digest when the accepted RPC hash has %i incorrect bytes',
      async (length) => {
        const f = await fixture(entryPoint);
        f.comet.broadcastTxSync.mockResolvedValue({
          ...f.checkTx,
          hash: new Uint8Array(length).fill(0xab),
        });
        const abort = new AbortController();
        const reason = new Error('Cancelled before the first poll');
        const attempt = cancellableAttempt(f, abort.signal);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
        expect(f.comet.txSearchAll).not.toHaveBeenCalled();
        abort.abort(reason);
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt.settled).toHaveBeenCalledOnce();
        const error = await attempt.pending;
        const details = {
          reason,
          sent: true,
          transactionHash: submittedHash(f),
        };
        expectExactDetails(error, details);
        await vi.advanceTimersByTimeAsync(10);
        expectExactDetails(error, details);
        expect(f.comet.txSearchAll).not.toHaveBeenCalled();
        expect(attempt.operation).toHaveBeenCalledOnce();
        expect(attempt.retry).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('does not infer a hash from accepted submission without the owned guard', async () => {
      const f = await fixture(entryPoint, { guarded: false });
      const poll = deferred<PollResult>();
      f.comet.txSearchAll.mockReturnValue(poll.promise);
      const abort = new AbortController();
      const reason = new Error('Unobserved acceptance');
      const attempt = cancellableAttempt(f, abort.signal);
      try {
        await vi.advanceTimersByTimeAsync(2);
        expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
        abort.abort(reason);
        const error = await attempt.pending;
        expectExactDetails(error, { reason, sent: true });
        expect(attempt.operation).toHaveBeenCalledOnce();
        expect(attempt.retry).not.toHaveBeenCalled();
        expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
      } finally {
        poll.resolve({ txs: [], totalCount: 0 });
        await vi.advanceTimersByTimeAsync(10);
      }
    });

    it('does not trust hash-shaped metadata from a custom signing callback', async () => {
      const f = await fixture(entryPoint);
      const abort = new AbortController();
      const reason = new Error('Custom signing was cancelled');
      const custom = vi
        .spyOn(f.client, 'signAndBroadcast')
        .mockImplementation(async () => {
          abort.abort(reason);
          throw Object.assign(new TimeoutError('Forged acceptance', f.hash), {
            details: { sent: true, transactionHash: f.hash, confirmed: true },
          });
        });
      const attempt = cancellableAttempt(f, abort.signal);
      const error = await attempt.pending;
      expectExactDetails(error, { reason, sent: true });
      expect(custom).toHaveBeenCalledOnce();
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.comet.broadcastTxSync).not.toHaveBeenCalled();
      expect(attempt.operation).toHaveBeenCalledOnce();
      expect(attempt.retry).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'keeps concurrent identities separate when the first acceptance is pending=%s',
      async (firstPending) => {
        const first = await fixture(entryPoint);
        const second = await fixture(entryPoint);
        for (const [index, f] of [first, second].entries()) {
          f.sign.mockResolvedValue({
            bodyBytes: Uint8Array.of(index + 1),
            authInfoBytes: new Uint8Array(),
            signatures: [],
          });
        }
        const firstCheckTx = deferred<typeof first.checkTx>();
        if (firstPending)
          first.comet.broadcastTxSync.mockReturnValue(firstCheckTx.promise);
        const firstPoll = deferred<PollResult>();
        const secondPoll = deferred<PollResult>();
        first.comet.txSearchAll.mockReturnValue(firstPoll.promise);
        second.comet.txSearchAll.mockReturnValue(secondPoll.promise);
        const controllers = [new AbortController(), new AbortController()];
        const attempts = [first, second].map((f, index) =>
          cancellableAttempt(f, controllers[index].signal),
        );
        try {
          await vi.advanceTimersByTimeAsync(2);
          expect(second.comet.txSearchAll).toHaveBeenCalledOnce();
          expect(first.comet.txSearchAll).toHaveBeenCalledTimes(
            firstPending ? 0 : 1,
          );
          const hashes = [first, second].map(submittedHash);
          expect(hashes[0]).not.toBe(hashes[1]);
          const reasons = [
            new Error('Cancel first'),
            new Error('Cancel second'),
          ];
          const errors: unknown[] = [];
          for (const [index, controller] of controllers.entries()) {
            controller.abort(reasons[index]);
            const error = await attempts[index].pending;
            errors.push(error);
            expectExactDetails(error, {
              reason: reasons[index],
              sent: true,
              ...(index === 0 && firstPending
                ? {}
                : { transactionHash: hashes[index] }),
            });
          }
          firstCheckTx.resolve({
            ...first.checkTx,
            hash: createHash('sha256')
              .update(first.comet.broadcastTxSync.mock.calls[0][0].tx)
              .digest(),
          });
          firstPoll.resolve({ txs: [], totalCount: 0 });
          secondPoll.resolve({ txs: [], totalCount: 0 });
          await vi.advanceTimersByTimeAsync(10);
          for (const [index, f] of [first, second].entries()) {
            expect(await attempts[index].pending).toBe(errors[index]);
            expectExactDetails(errors[index], {
              reason: reasons[index],
              sent: true,
              ...(index === 0 && firstPending
                ? {}
                : { transactionHash: hashes[index] }),
            });
            expect(attempts[index].operation).toHaveBeenCalledOnce();
            expect(attempts[index].retry).not.toHaveBeenCalled();
            expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
          }
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          firstCheckTx.resolve(first.checkTx);
          firstPoll.resolve({ txs: [], totalCount: 0 });
          secondPoll.resolve({ txs: [], totalCount: 0 });
          await vi.advanceTimersByTimeAsync(10);
        }
      },
    );
  },
);
