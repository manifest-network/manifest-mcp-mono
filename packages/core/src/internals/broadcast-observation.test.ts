import { createHash } from 'node:crypto';
import { type SigningStargateClient, TimeoutError } from '@cosmjs/stargate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeInclusionTimeoutFixture } from '../__test-utils__/mocks.js';
import { isOwnedBroadcastFailure } from './broadcast-failure.js';
import { type SequenceCache, sequencedSigningClient } from './tx-sequence.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('per-operation native acceptance observation', () => {
  it('reports the local hash after accepted SYNC, before polling settles', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const accepted = vi.fn();
    const settled = vi.fn();
    const client = sequencedSigningClient(f.client, new Map(), accepted);
    const pending = client
      .signAndBroadcast(f.sender, f.messages, f.fee)
      .catch((error: unknown) => error);
    void pending.then(settled);

    await vi.advanceTimersByTimeAsync(0);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(f.hash);
    expect(settled).not.toHaveBeenCalled();
    expect(f.comet.txSearchAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(isOwnedBroadcastFailure(await pending)).toBe(true);
    expect(accepted).toHaveBeenCalledOnce();
    expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves cached signing sequence and the original query receiver', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const committed = vi.spyOn(f.client, 'getSequence');
    const sequences: number[] = [];
    let signingReceiver: SigningStargateClient | undefined;
    f.sign.mockImplementation(async function (this: SigningStargateClient) {
      signingReceiver = this;
      sequences.push((await this.getSequence(f.sender)).sequence);
      return {
        bodyBytes: new Uint8Array(),
        authInfoBytes: new Uint8Array(),
        signatures: [],
      };
    });
    const queryReceivers: SigningStargateClient[] = [];
    vi.spyOn(f.client, 'getTx').mockImplementation(async function (
      this: SigningStargateClient,
    ) {
      queryReceivers.push(this);
      return null;
    });
    const cache: SequenceCache = new Map([
      [f.sender, { accountNumber: 1, sequence: 8 }],
    ]);
    const accepted = vi.fn();
    const client = sequencedSigningClient(f.client, cache, accepted);
    const pending = client
      .signAndBroadcast(f.sender, f.messages, f.fee)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2);

    expect(isOwnedBroadcastFailure(await pending)).toBe(true);
    expect(sequences).toEqual([8]);
    expect(committed).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledExactlyOnceWith(f.hash);
    expect(queryReceivers).toEqual([signingReceiver]);
    expect(signingReceiver).not.toBe(f.client);
    expect(cache.has(f.sender)).toBe(false);
  });

  it('keeps two concurrent operation observers on the same raw client separate', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    for (const byte of [1, 2]) {
      f.sign.mockResolvedValueOnce({
        bodyBytes: Uint8Array.of(byte),
        authInfoBytes: new Uint8Array(),
        signatures: [],
      });
    }
    const observers = [vi.fn(), vi.fn()];
    const pending = observers.map((accepted) =>
      sequencedSigningClient(f.client, new Map(), accepted)
        .signAndBroadcast(f.sender, f.messages, f.fee)
        .catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.comet.broadcastTxSync).toHaveBeenCalledTimes(2);
    const hashes = f.comet.broadcastTxSync.mock.calls.map(([{ tx }]) =>
      createHash('sha256').update(tx).digest('hex').toUpperCase(),
    );
    expect(hashes[0]).not.toBe(hashes[1]);
    for (const [index, accepted] of observers.entries()) {
      expect(accepted).toHaveBeenCalledExactlyOnceWith(hashes[index]);
    }
    await vi.advanceTimersByTimeAsync(2);
    for (const error of await Promise.all(pending)) {
      expect(isOwnedBroadcastFailure(error)).toBe(true);
    }
    expect(f.comet.txSearchAll).toHaveBeenCalledTimes(2);
  });

  it('preserves the fast-path custom signing and lookup receivers', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const signingReceivers: SigningStargateClient[] = [];
    f.sign.mockImplementation(async function (this: SigningStargateClient) {
      signingReceivers.push(this);
      return {
        bodyBytes: new Uint8Array(),
        authInfoBytes: new Uint8Array(),
        signatures: [],
      };
    });
    const queryReceivers: SigningStargateClient[] = [];
    vi.spyOn(f.client, 'getTx').mockImplementation(async function (
      this: SigningStargateClient,
    ) {
      queryReceivers.push(this);
      return null;
    });
    const accepted = vi.fn();
    const client = sequencedSigningClient(f.client, new Map(), accepted);
    const pending = client
      .signAndBroadcast(f.sender, f.messages, f.fee)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2);
    expect(isOwnedBroadcastFailure(await pending)).toBe(true);
    expect(accepted).toHaveBeenCalledExactlyOnceWith(f.hash);
    expect(signingReceivers).toEqual([f.client]);
    expect(queryReceivers).toEqual([f.client]);
  });

  it('does not observe a custom signing entry point replaced after wrapper creation', async () => {
    const f = await makeInclusionTimeoutFixture();
    f.installGuard();
    const accepted = vi.fn();
    const client = sequencedSigningClient(f.client, new Map(), accepted);
    const original = new Error('custom signing entry point');
    const custom = vi
      .fn<SigningStargateClient['signAndBroadcast']>()
      .mockImplementation(async function (this: SigningStargateClient) {
        expect(this).toBe(f.client);
        throw original;
      });
    f.client.signAndBroadcast = custom;
    await expect(
      client.signAndBroadcast(f.sender, f.messages, f.fee),
    ).rejects.toBe(original);
    expect(custom).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
    expect(f.comet.broadcastTxSync).not.toHaveBeenCalled();
  });

  it.each(['broadcast', 'sync'])(
    'does not observe a custom %s method replaced after wrapper creation',
    async (method) => {
      const f = await makeInclusionTimeoutFixture();
      f.installGuard();
      const accepted = vi.fn();
      const client = sequencedSigningClient(f.client, new Map(), accepted);
      const original = new Error('custom broadcast');
      if (method === 'broadcast') {
        f.client.broadcastTx = vi.fn().mockRejectedValue(original);
      } else {
        f.client.broadcastTxSync = vi.fn().mockResolvedValue(f.hash);
      }
      const pending = client
        .signAndBroadcast(f.sender, f.messages, f.fee)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2);
      const error = await pending;
      if (method === 'broadcast') expect(error).toBe(original);
      else expect(error).toBeInstanceOf(TimeoutError);
      expect(accepted).not.toHaveBeenCalled();
      expect(isOwnedBroadcastFailure(error)).toBe(false);
      expect(f.comet.broadcastTxSync).not.toHaveBeenCalled();
    },
  );

  it.each(['throw', 'reject'])(
    'ignores observer %s failures without changing native polling or its error',
    async (mode) => {
      const f = await makeInclusionTimeoutFixture();
      f.installGuard();
      const sinkFailure = new Error('observer failed');
      const accepted = vi.fn(() => {
        if (mode === 'throw') throw sinkFailure;
        return Promise.reject(sinkFailure);
      });
      const client = sequencedSigningClient(f.client, new Map(), accepted);
      const pending = client
        .signAndBroadcast(f.sender, f.messages, f.fee)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2);
      const error = await pending;
      expect(accepted).toHaveBeenCalledExactlyOnceWith(f.hash);
      expect(isOwnedBroadcastFailure(error)).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(error, 'cause')?.value,
      ).toBeInstanceOf(TimeoutError);
      expect(f.comet.txSearchAll).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
