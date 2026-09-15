import { createHash } from 'node:crypto';
import {
  BroadcastTxError,
  SigningStargateClient,
  StargateClient,
  TimeoutError,
} from '@cosmjs/stargate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  expectExactDetails,
  makeInclusionTimeoutFixture,
  makeMockConfig,
} from './__test-utils__/mocks.js';
import { CosmosClientManager } from './client.js';
import { isOwnedBroadcastFailure } from './internals/broadcast-failure.js';
import { withRetry } from './retry.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

const managers: CosmosClientManager[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.disconnectWhenIdle();
  // The pinned native producer starts a timer before CheckTx and leaves it
  // pending when CheckTx itself rejects. Do not let fixture timers escape.
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function managedFixture(
  options?: Parameters<typeof makeInclusionTimeoutFixture>[0],
) {
  const fixture = await makeInclusionTimeoutFixture(options);
  const connect = vi
    .spyOn(SigningStargateClient, 'connectWithSigner')
    .mockResolvedValue(fixture.client);
  const manager = CosmosClientManager.getInstance(
    makeMockConfig({ chainId: fixture.chainId, retry: { maxRetries: 0 } }),
    {
      getAddress: async () => fixture.sender,
      getSigner: async () => fixture.signer,
    },
  );
  managers.push(manager);
  const client = await manager.getBroadcastClient();
  return { ...fixture, client, rawClient: fixture.client, connect, manager };
}

describe('pinned inclusion timeout through the SDK-owned signing client', () => {
  it('exercises the actual native timeout branch after accepted CheckTx and one empty lookup', async () => {
    const fixture = await makeInclusionTimeoutFixture();
    expect(fixture.client.broadcastTx).toBe(
      StargateClient.prototype.broadcastTx,
    );
    expect(fixture.client.broadcastTxSync).toBe(
      StargateClient.prototype.broadcastTxSync,
    );
    const pending = fixture.client
      .signAndBroadcast(fixture.sender, fixture.messages, fixture.fee)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2);
    const error = await pending;

    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ name: 'Error', txId: fixture.hash });
    expect(isOwnedBroadcastFailure(error)).toBe(false);
    expect(fixture.sign).toHaveBeenCalledOnce();
    expect(fixture.signer.signDirect).not.toHaveBeenCalled();
    expect(fixture.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expect(fixture.hash).toBe(
      createHash('sha256')
        .update(fixture.comet.broadcastTxSync.mock.calls[0][0].tx)
        .digest('hex')
        .toUpperCase(),
    );
    expect(fixture.comet.txSearchAll).toHaveBeenCalledExactlyOnceWith({
      query: `tx.hash='${fixture.hash}'`,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('manager initialization installs the guard and preserves sparse timeout evidence without retrying', async () => {
    const fixture = await managedFixture();
    const onRetry = vi.fn();
    const pending = withRetry(
      () =>
        fixture.client.signAndBroadcast(
          fixture.sender,
          fixture.messages,
          fixture.fee,
        ),
      {
        config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
        onRetry,
      },
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4);
    const error = await pending;

    expect(error).toBeInstanceOf(ManifestMCPError);
    if (!(error instanceof ManifestMCPError))
      throw new Error('expected owned timeout');
    expect(error.code).toBe(ManifestMCPErrorCode.TX_FAILED);
    expectExactDetails(error, {
      sent: true,
      transactionHash: fixture.hash,
    });
    expect(isOwnedBroadcastFailure(error)).toBe(true);
    const cause = Object.getOwnPropertyDescriptor(error, 'cause');
    expect(cause).toMatchObject({ enumerable: false });
    expect(cause?.value).toBeInstanceOf(TimeoutError);
    expect(cause?.value).toMatchObject({ name: 'Error', txId: fixture.hash });
    expect(error.message).toBe(cause?.value.message);
    expect(cause?.value).not.toHaveProperty('details');
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.comet.status).toHaveBeenCalledOnce();
    expect(fixture.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expect(fixture.comet.txSearchAll).toHaveBeenCalledOnce();
    expect(fixture.sign).toHaveBeenCalledExactlyOnceWith(
      fixture.sender,
      fixture.messages,
      fixture.fee,
      '',
      undefined,
      undefined,
    );
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(['sign', 'simulate'] as const)(
    'does not infer submission from a genuine TimeoutError thrown during %s',
    async (stage) => {
      const fixture = await managedFixture();
      const original = Object.freeze(
        new TimeoutError('not a submitted transaction', fixture.hash),
      );
      if (stage === 'sign') fixture.sign.mockRejectedValue(original);
      else vi.spyOn(fixture.rawClient, 'simulate').mockRejectedValue(original);
      const error = await fixture.client
        .signAndBroadcast(
          fixture.sender,
          fixture.messages,
          stage === 'simulate' ? 'auto' : fixture.fee,
        )
        .catch((caught: unknown) => caught);

      expect(error).toBe(original);
      expect(isOwnedBroadcastFailure(error)).toBe(false);
      expect(error).not.toHaveProperty('details');
      expect(fixture.comet.broadcastTxSync).not.toHaveBeenCalled();
      expect(fixture.comet.txSearchAll).not.toHaveBeenCalled();
    },
  );

  it('does not infer acceptance from a nonzero CheckTx response with a valid hash', async () => {
    const fixture = await managedFixture();
    fixture.comet.broadcastTxSync.mockResolvedValue({
      ...fixture.checkTx,
      code: 11,
      codespace: 'sdk',
      log: 'CheckTx rejected',
    });
    const error = await fixture.client
      .signAndBroadcast(fixture.sender, fixture.messages, fixture.fee)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BroadcastTxError);
    expect(isOwnedBroadcastFailure(error)).toBe(false);
    expect(error).not.toHaveProperty('details');
    expect(fixture.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expect(fixture.comet.txSearchAll).not.toHaveBeenCalled();
  });

  it.each([31, 32, 33])(
    'rejects an incorrect %i-byte CheckTx hash without polling or retrying',
    async (length) => {
      const fixture = await managedFixture({
        hashBytes: new Uint8Array(length).fill(0xab),
      });
      const getTx = vi.spyOn(fixture.rawClient, 'getTx');
      const onRetry = vi.fn();
      const pending = withRetry(
        () =>
          fixture.client.signAndBroadcast(
            fixture.sender,
            fixture.messages,
            fixture.fee,
          ),
        {
          config: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
          onRetry,
        },
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4);
      const error = await pending;

      expect(fixture.comet.broadcastTxSync).toHaveBeenCalledOnce();
      const submitted = fixture.comet.broadcastTxSync.mock.calls[0][0].tx;
      const localHash = createHash('sha256')
        .update(submitted)
        .digest('hex')
        .toUpperCase();
      expect(fixture.hash).toBe(localHash);
      expect(error).toMatchObject({ code: ManifestMCPErrorCode.TX_FAILED });
      expectExactDetails(error, { sent: true, transactionHash: localHash });
      expect(isOwnedBroadcastFailure(error)).toBe(true);
      expect(getTx).not.toHaveBeenCalled();
      expect(fixture.comet.txSearchAll).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    {
      label: 'plain transport error',
      original: Object.freeze(new Error('transaction lookup disconnected')),
    },
    {
      label: 'forged timeout with another transaction ID',
      original: Object.freeze(
        new TimeoutError('unrelated timeout', 'C'.repeat(64)),
      ),
    },
    {
      label: 'native request timeout',
      original: new DOMException('read deadline elapsed', 'TimeoutError'),
    },
  ])(
    'retains observed acceptance when the real lookup rejects with $label',
    async ({ original }) => {
      const fixture = await managedFixture();
      fixture.comet.txSearchAll.mockRejectedValue(original);
      const pending = fixture.client
        .signAndBroadcast(fixture.sender, fixture.messages, fixture.fee)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2);
      const error = await pending;

      expect(error).toBeInstanceOf(ManifestMCPError);
      if (!(error instanceof ManifestMCPError))
        throw new Error('expected owned broadcast failure');
      expect(error.code).toBe(ManifestMCPErrorCode.TX_FAILED);
      expectExactDetails(error, {
        sent: true,
        transactionHash: fixture.hash,
      });
      expect(isOwnedBroadcastFailure(error)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(error, 'cause')).toMatchObject({
        value: original,
        enumerable: false,
      });
      expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toBe(
        original,
      );
      expect(original).not.toHaveProperty('details');
      expect(fixture.comet.broadcastTxSync).toHaveBeenCalledOnce();
      expect(fixture.comet.txSearchAll).toHaveBeenCalledOnce();
    },
  );

  it('preserves an injected lookup cancellation code after acceptance while retaining its original cause', async () => {
    const fixture = await managedFixture();
    const original = Object.freeze(
      new ManifestMCPError(
        ManifestMCPErrorCode.OPERATION_CANCELLED,
        'transaction lookup was cancelled',
      ),
    );
    fixture.comet.txSearchAll.mockRejectedValue(original);
    const pending = fixture.client
      .signAndBroadcast(fixture.sender, fixture.messages, fixture.fee)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2);
    const error = await pending;

    expect(error).toMatchObject({
      code: ManifestMCPErrorCode.OPERATION_CANCELLED,
    });
    expectExactDetails(error, { sent: true, transactionHash: fixture.hash });
    expect(error).not.toBe(original);
    expect(isOwnedBroadcastFailure(error)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toBe(
      original,
    );
    expect(fixture.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expect(fixture.comet.txSearchAll).toHaveBeenCalledOnce();
  });

  it('keeps the async signing path hash-only without starting inclusion polling', async () => {
    const fixture = await managedFixture();
    vi.spyOn(fixture.rawClient, 'getSequence').mockResolvedValue({
      accountNumber: 1,
      sequence: 3,
    });
    const result = await fixture.client.signAndBroadcastSync(
      fixture.sender,
      fixture.messages,
      fixture.fee,
    );

    expect(result).toBe(fixture.hash);
    expect(fixture.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expect(fixture.comet.txSearchAll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves native success when the first lookup finds inclusion after the timeout flag expires', async () => {
    const fixture = await managedFixture();
    fixture.comet.txSearchAll.mockResolvedValue({
      txs: [
        {
          height: 7,
          hash: fixture.checkTx.hash,
          index: 0,
          tx: new Uint8Array(),
          result: { code: 0, events: [], gasUsed: 10n, gasWanted: 20n },
        },
      ],
      totalCount: 1,
    });
    const pending = fixture.client.signAndBroadcast(
      fixture.sender,
      fixture.messages,
      fixture.fee,
    );
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;

    expect(result).toMatchObject({
      code: 0,
      height: 7,
      transactionHash: fixture.hash,
    });
    expect(fixture.comet.broadcastTxSync).toHaveBeenCalledOnce();
    expect(fixture.comet.txSearchAll).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
