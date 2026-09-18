import { createHash } from 'node:crypto';
import { type SigningStargateClient, TimeoutError } from '@cosmjs/stargate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expectExactDetails,
  makeInclusionTimeoutFixture,
} from '../__test-utils__/mocks.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import {
  attributeBroadcastFailure,
  installBroadcastFailureGuard,
  isOwnedBroadcastFailure,
} from './broadcast-failure.js';
import { type SequenceCache, sequencedSigningClient } from './tx-sequence.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('owned inclusion-timeout receiver and provenance boundaries', () => {
  it.each([false, true])(
    'redacts a mnemonic before adding owned transaction context while retaining local cause and receipt (controls: %s)',
    async (controls) => {
      const f = await makeInclusionTimeoutFixture();
      f.installGuard();
      const mnemonic = `${'abandon '.repeat(11)}about`;
      const message = controls ? `\u001b[31m${mnemonic}\u001b[0m` : mnemonic;
      const original = new Error(message);
      f.comet.txSearchAll.mockRejectedValue(original);
      const pending = f.client
        .signAndBroadcast(f.sender, f.messages, f.fee)
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      await vi.advanceTimersByTimeAsync(2);
      const { error } = await pending;
      const attributed = attributeBroadcastFailure(
        error,
        'Tx bank send failed: ',
        { module: 'bank', subcommand: 'send', args: [] },
      );
      expect(attributed).toBeInstanceOf(ManifestMCPError);
      expect(attributed?.message).toBe(
        'Tx bank send failed: [REDACTED - possible mnemonic]',
      );
      expectExactDetails(attributed, {
        sent: true,
        transactionHash: f.hash,
        module: 'bank',
        subcommand: 'send',
        args: [],
      });
      expect(Object.getOwnPropertyDescriptor(attributed, 'cause')?.value).toBe(
        error,
      );
      expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toBe(
        original,
      );
      expect(original.message).toBe(message);
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
    },
  );

  it('preserves a cached sequence receiver and invalidates the cache after the owned timeout', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const committedSequence = vi
      .spyOn(f.client, 'getSequence')
      .mockResolvedValue({ accountNumber: 1, sequence: 5 });
    const sequences: number[] = [];
    f.sign.mockImplementation(async function (this: SigningStargateClient) {
      sequences.push((await this.getSequence(f.sender)).sequence);
      return {
        bodyBytes: new Uint8Array(),
        authInfoBytes: new Uint8Array(),
        signatures: [],
      };
    });
    const cache: SequenceCache = new Map([
      [f.sender, { accountNumber: 1, sequence: 8 }],
    ]);
    const client = sequencedSigningClient(f.client, cache);
    const pending = client
      .signAndBroadcast(f.sender, f.messages, f.fee)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2);
    const error = await pending;
    expect(isOwnedBroadcastFailure(error)).toBe(true);
    expect(error).toMatchObject({
      code: ManifestMCPErrorCode.TX_FAILED,
      details: { sent: true, transactionHash: f.hash },
    });
    expectExactDetails(error, { sent: true, transactionHash: f.hash });
    expect(sequences).toEqual([8]);
    expect(committedSequence).not.toHaveBeenCalled();
    expect(cache.has(f.sender)).toBe(false);
    expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
  });

  it('keeps simultaneous calls on distinct receiver views independent', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const first = Object.create(f.client) as SigningStargateClient;
    const second = Object.create(f.client) as SigningStargateClient;
    const pending = [first, second].map((client, index) =>
      client
        .broadcastTx(Uint8Array.of(index), 1, 2)
        .catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(2);
    const errors = await Promise.all(pending);
    const hashes = [0, 1].map((value) =>
      createHash('sha256')
        .update(Uint8Array.of(value))
        .digest('hex')
        .toUpperCase(),
    );
    for (const [index, hash] of hashes.entries()) {
      const error = errors[index];
      expect(isOwnedBroadcastFailure(error)).toBe(true);
      if (!isOwnedBroadcastFailure(error))
        throw new Error('expected owned timeout');
      expectExactDetails(error, { sent: true, transactionHash: hash });
      expect(
        Object.getOwnPropertyDescriptor(error, 'cause')?.value,
      ).toMatchObject({ txId: hash });
    }
    expect(f.comet.broadcastTxSync).toHaveBeenCalledTimes(2);
    expect(f.comet.txSearchAll).toHaveBeenCalledTimes(2);
  });

  it('does not let one accepted call authorize a concurrent delegated timeout', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const delegated = new TimeoutError('rejected before acceptance', f.hash);
    f.comet.broadcastTxSync
      .mockResolvedValueOnce({
        ...f.checkTx,
        hash: createHash('sha256').update(Uint8Array.of(1)).digest(),
      })
      .mockRejectedValueOnce(delegated);
    const first = f.client
      .broadcastTx(Uint8Array.of(1), 1, 2)
      .catch((error: unknown) => error);
    const second = f.client
      .broadcastTx(Uint8Array.of(2), 1, 2)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2);
    const acceptedFailure = await first;
    expect(isOwnedBroadcastFailure(acceptedFailure)).toBe(true);
    expectExactDetails(acceptedFailure, {
      sent: true,
      transactionHash: createHash('sha256')
        .update(Uint8Array.of(1))
        .digest('hex')
        .toUpperCase(),
    });
    expect(await second).toBe(delegated);
    expect(isOwnedBroadcastFailure(delegated)).toBe(false);
    expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'before the deadline', timeoutMs: 10_000, responseDelayMs: 0 },
    { label: 'after the deadline', timeoutMs: 1, responseDelayMs: 10 },
  ])(
    'rejects an incorrect accepted hash $label and clears native timers',
    async ({ timeoutMs, responseDelayMs }) => {
      const f = await makeInclusionTimeoutFixture({
        hashBytes: new Uint8Array(32).fill(0xab),
      });
      f.installGuard();
      f.comet.broadcastTxSync.mockImplementationOnce(async () => {
        if (responseDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
        }
        return f.checkTx;
      });
      const getTx = vi.spyOn(f.client, 'getTx');
      const tx = Uint8Array.of(1, 2, 3);
      const localHash = createHash('sha256')
        .update(tx)
        .digest('hex')
        .toUpperCase();
      const settled = vi.fn();
      const pending = f.client
        .broadcastTx(tx, timeoutMs, 2)
        .catch((error: unknown) => error);
      void pending.then(settled);
      await vi.advanceTimersByTimeAsync(responseDelayMs + 2);
      expect(settled).toHaveBeenCalledOnce();
      const error = await pending;

      expect(isOwnedBroadcastFailure(error)).toBe(true);
      if (!isOwnedBroadcastFailure(error))
        throw new Error('expected local hash evidence');
      expect(error.code).toBe(ManifestMCPErrorCode.TX_FAILED);
      expect(error.message).toContain('hash');
      expectExactDetails(error, { sent: true, transactionHash: localHash });
      expect(getTx).not.toHaveBeenCalled();
      expect(f.comet.txSearchAll).not.toHaveBeenCalled();
      expect(f.comet.broadcastTxSync).toHaveBeenCalledExactlyOnceWith({ tx });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('hashes and submits a byte snapshot even if the caller mutates its input', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const input = Uint8Array.of(1, 2, 3);
    const originalBytes = input.slice();
    const localHash = createHash('sha256')
      .update(originalBytes)
      .digest('hex')
      .toUpperCase();
    const pending = f.client
      .broadcastTx(input, 1, 2)
      .catch((error: unknown) => error);
    input.fill(0xff);
    await vi.advanceTimersByTimeAsync(2);
    const error = await pending;

    expectExactDetails(error, { sent: true, transactionHash: localHash });
    expect(f.comet.broadcastTxSync).toHaveBeenCalledExactlyOnceWith({
      tx: originalBytes,
    });
    expect(f.comet.broadcastTxSync.mock.calls[0][0].tx).not.toBe(input);
    expect(f.comet.txSearchAll).toHaveBeenCalledExactlyOnceWith({
      query: `tx.hash='${localHash}'`,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves accepted submission evidence when a customized poll throws a TimeoutError', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const delegated = Object.freeze(
      new TimeoutError('query supplied this error', f.hash),
    );
    const query = vi.spyOn(f.client, 'getTx').mockRejectedValue(delegated);
    const pending = f.client
      .signAndBroadcast(f.sender, f.messages, f.fee)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2);
    const error = await pending;
    expect(isOwnedBroadcastFailure(error)).toBe(true);
    if (!isOwnedBroadcastFailure(error))
      throw new Error('expected accepted broadcast failure');
    expectExactDetails(error, { sent: true, transactionHash: f.hash });
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toBe(
      delegated,
    );
    expect(isOwnedBroadcastFailure(delegated)).toBe(false);
    expect(delegated).not.toHaveProperty('details');
    expect(query).toHaveBeenCalledOnce();
    expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
  });

  it('does not decorate a custom broadcast implementation', async () => {
    const f = await makeInclusionTimeoutFixture();
    const delegated = new TimeoutError('custom broadcast', f.hash);
    const broadcast = vi
      .fn<SigningStargateClient['broadcastTx']>()
      .mockRejectedValue(delegated);
    f.client.broadcastTx = broadcast;
    expect(f.installGuard()).toBe(false);
    await expect(
      f.client.signAndBroadcast(f.sender, f.messages, f.fee),
    ).rejects.toBe(delegated);
    expect(f.client.broadcastTx).toBe(broadcast);
    expect(isOwnedBroadcastFailure(delegated)).toBe(false);
    expect(f.comet.broadcastTxSync).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'])(
    'leaves a custom SYNC implementation untrusted when installed %s the guard',
    async (when) => {
      const f = await makeInclusionTimeoutFixture();
      if (when === 'after') f.installGuard();
      const sync = vi
        .fn<SigningStargateClient['broadcastTxSync']>()
        .mockResolvedValue(f.hash);
      f.client.broadcastTxSync = sync;
      expect(f.installGuard()).toBe(false);
      const pending = f.client
        .signAndBroadcast(f.sender, f.messages, f.fee)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2);
      const error = await pending;
      expect(error).toBeInstanceOf(TimeoutError);
      expect(isOwnedBroadcastFailure(error)).toBe(false);
      expect(sync).toHaveBeenCalledOnce();
      expect(f.comet.broadcastTxSync).not.toHaveBeenCalled();
    },
  );

  it('installation is idempotent and copied public error fields cannot forge internal provenance', async () => {
    const f = await makeInclusionTimeoutFixture();
    expect(f.installGuard()).toBe(true);
    const broadcast = f.client.broadcastTx;
    expect(installBroadcastFailureGuard(f.client)).toBe(true);
    expect(f.client.broadcastTx).toBe(broadcast);
    const forged = new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      'timeout',
      { sent: true, transactionHash: f.hash },
    );
    expect(isOwnedBroadcastFailure(forged)).toBe(false);
    expect(isOwnedBroadcastFailure(null)).toBe(false);
  });

  it("preserves a customized query method's exact receiver", async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const realGetTx = f.client.getTx;
    const receivers: SigningStargateClient[] = [];
    vi.spyOn(f.client, 'getTx').mockImplementation(function (
      this: SigningStargateClient,
      hash,
    ) {
      receivers.push(this);
      return realGetTx.call(this, hash);
    });
    const pending = f.client
      .broadcastTx(Uint8Array.of(1), 1, 2)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2);
    const error = await pending;
    expect(isOwnedBroadcastFailure(error)).toBe(true);
    expectExactDetails(error, {
      sent: true,
      transactionHash: createHash('sha256')
        .update(Uint8Array.of(1))
        .digest('hex')
        .toUpperCase(),
    });
    expect(receivers).toHaveLength(1);
    expect(receivers[0]).toBe(f.client);
  });

  it.each([
    {
      label: 'throwing SDK code getter',
      create: () => {
        const error = new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'readable message',
        );
        Object.defineProperty(error, 'code', {
          get() {
            throw new Error('unreadable code');
          },
        });
        return Object.freeze(error);
      },
      code: ManifestMCPErrorCode.TX_FAILED,
      message: 'readable message',
    },
    {
      label: 'throwing cancellation message getter',
      create: () => {
        const error = new ManifestMCPError(
          ManifestMCPErrorCode.OPERATION_CANCELLED,
          'unused',
        );
        Object.defineProperty(error, 'message', {
          get() {
            throw new Error('unreadable message');
          },
        });
        return Object.freeze(error);
      },
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
      message: 'Broadcast error message unavailable',
    },
    {
      label: 'throwing raw coercion',
      create: () =>
        Object.freeze({
          [Symbol.toPrimitive]() {
            throw new Error('unreadable value');
          },
        }),
      code: ManifestMCPErrorCode.TX_FAILED,
      message: 'Broadcast error message unavailable',
    },
    {
      label: 'revoked proxy',
      create: () => {
        const value = Proxy.revocable({}, {});
        value.revoke();
        return value.proxy;
      },
      code: ManifestMCPErrorCode.TX_FAILED,
      message: 'Broadcast error message unavailable',
    },
    {
      label: 'raw string rejection',
      create: () => 'poll failed',
      code: ManifestMCPErrorCode.TX_FAILED,
      message: 'poll failed',
    },
  ])(
    'retains accepted evidence and the original cause with $label',
    async ({ create, code, message }) => {
      const f = await makeInclusionTimeoutFixture();
      f.installGuard();
      const original: unknown = create();
      f.comet.txSearchAll.mockRejectedValue(original);
      const pending = f.client
        .signAndBroadcast(f.sender, f.messages, f.fee)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2);
      const error = await pending;
      expect(isOwnedBroadcastFailure(error)).toBe(true);
      if (!isOwnedBroadcastFailure(error))
        throw new Error('expected accepted broadcast failure');
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expectExactDetails(error, { sent: true, transactionHash: f.hash });
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      expect(cause?.value).toBe(original);
      expect(cause?.enumerable).toBe(false);
      expect(f.comet.broadcastTxSync).toHaveBeenCalledOnce();
      expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
      // This asserts preservation at the broadcast boundary, not support for arbitrary
      // hostile objects in downstream consumers of the untouched original cause.
    },
  );
});
