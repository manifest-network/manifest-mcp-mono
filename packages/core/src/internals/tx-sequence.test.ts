import type { SigningStargateClient } from '@cosmjs/stargate';
import { describe, expect, it, vi } from 'vitest';
import { type SequenceCache, sequencedSigningClient } from './tx-sequence.js';

const SENDER = 'manifest1sender';
const MSGS = [{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: {} }] as never;
const FEE = 'auto' as never;

/**
 * A stand-in SigningStargateClient. Its broadcast methods read `this.getSequence()` exactly like the
 * real cosmjs ones do (via `sign`), so the sequence a broadcast actually SIGNS with is observable in
 * `used`. `getSequence` returns the committed sequence starting at `committed`.
 */
function makeMockClient(committed = 5) {
  const used: number[] = [];
  const getSequence = vi.fn(async () => ({
    accountNumber: 1,
    sequence: committed,
  }));
  const record = async function (this: SigningStargateClient) {
    const { sequence } = await this.getSequence(SENDER);
    used.push(sequence);
    return `HASH_${sequence}`;
  };
  const client = {
    getSequence,
    getChainId: vi.fn(async () => 'test-chain'),
    simulate: vi.fn(async () => 100_000),
    signAndBroadcast: vi.fn(async function (this: SigningStargateClient) {
      const { sequence } = await this.getSequence(SENDER);
      used.push(sequence);
      return { code: 0, transactionHash: `HASH_${sequence}`, height: 1 };
    }),
    signAndBroadcastSync: vi.fn(record),
  } as unknown as SigningStargateClient;
  return { client, getSequence, used };
}

describe('sequencedSigningClient', () => {
  it('consecutive SYNC broadcasts use consecutive sequences and query the committed sequence only once', async () => {
    const cache: SequenceCache = new Map();
    const { client, getSequence, used } = makeMockClient(5);
    const wrapped = sequencedSigningClient(client, cache);

    await wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, '');
    await wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, '');
    await wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, '');

    // Signed with 5, 6, 7 — NOT 5, 5, 5 (the pre-inclusion committed sequence).
    expect(used).toEqual([5, 6, 7]);
    // Committed sequence seeded once; subsequent broadcasts advance the local counter.
    expect(getSequence).toHaveBeenCalledTimes(1);
  });

  it('a blocking broadcast with no in-flight sync tx keeps cosmjs default (fast path, no local tracking)', async () => {
    const cache: SequenceCache = new Map();
    const { client, used } = makeMockClient(5);
    const wrapped = sequencedSigningClient(client, cache);

    await wrapped.signAndBroadcast(SENDER, MSGS, FEE, '');

    expect(used).toEqual([5]); // committed sequence, cosmjs default
    expect(cache.has(SENDER)).toBe(false); // no local tracking populated
    expect(client.signAndBroadcast).toHaveBeenCalledOnce();
  });

  it('a blocking broadcast after sync broadcasts uses the tracked sequence, then clears the cache', async () => {
    const cache: SequenceCache = new Map();
    const { client, used } = makeMockClient(5);
    const wrapped = sequencedSigningClient(client, cache);

    await wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, ''); // 5
    await wrapped.signAndBroadcast(SENDER, MSGS, FEE, ''); // must be 6, not re-read committed 5

    expect(used).toEqual([5, 6]);
    // Blocking waited for inclusion → committed is authoritative again → local tracking dropped.
    expect(cache.has(SENDER)).toBe(false);
  });

  it('resets local tracking when a broadcast throws (next broadcast re-queries committed)', async () => {
    const cache: SequenceCache = new Map();
    const { client, getSequence, used } = makeMockClient(5);
    const wrapped = sequencedSigningClient(client, cache);

    await wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, ''); // 5 → cache {6}
    (
      client.signAndBroadcastSync as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('checktx rejected'));
    await expect(
      wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, ''),
    ).rejects.toThrow('checktx rejected');
    expect(cache.has(SENDER)).toBe(false);

    // Next broadcast re-queries committed (getSequence called again).
    await wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, '');
    expect(getSequence).toHaveBeenCalledTimes(2); // seed #1 + re-seed after reset
    expect(used[used.length - 1]).toBe(5); // re-read committed 5
  });

  it('delegates non-broadcast methods (simulate) straight to the real client', async () => {
    const cache: SequenceCache = new Map();
    const { client } = makeMockClient(5);
    const wrapped = sequencedSigningClient(client, cache);

    const gas = await wrapped.simulate(SENDER, MSGS, '');
    expect(gas).toBe(100_000);
    expect(client.simulate).toHaveBeenCalledOnce();
  });

  it('tracks sequences per-signer independently', async () => {
    const cache: SequenceCache = new Map();
    const { client, used } = makeMockClient(5);
    const wrapped = sequencedSigningClient(client, cache);
    const OTHER = 'manifest1other';

    await wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, ''); // 5
    await wrapped.signAndBroadcastSync(OTHER, MSGS, FEE, ''); // independent → 5
    await wrapped.signAndBroadcastSync(SENDER, MSGS, FEE, ''); // 6

    expect(used).toEqual([5, 5, 6]);
  });
});
