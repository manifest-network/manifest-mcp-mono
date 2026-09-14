import { toBech32, toHex } from '@cosmjs/encoding';
import type { EncodeObject } from '@cosmjs/proto-signing';
import { GasPrice, SigningStargateClient, type StdFee } from '@cosmjs/stargate';
import { vi } from 'vitest';
import { installBroadcastFailureGuard } from '../internals/broadcast-failure.js';

type CometClient = Parameters<typeof SigningStargateClient.createWithSigner>[0];
type OfflineSigner = Parameters<
  typeof SigningStargateClient.createWithSigner
>[1];

export interface InclusionTimeoutFixtureOptions {
  readonly chainId?: string;
  readonly hashBytes?: Uint8Array;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * Real pinned signing/broadcast/poll methods with only signing and Comet seams
 * replaced. The default client is unguarded so manager installation is testable.
 * With fake timers, advancing 2 ms produces one accepted CheckTx response, one
 * empty transaction lookup and the native inclusion TimeoutError. No sockets or
 * real signatures are used. Callers exercising automatic gas can mock simulate.
 */
export async function makeInclusionTimeoutFixture(
  options: InclusionTimeoutFixtureOptions = {},
) {
  const chainId = options.chainId ?? 'test-chain';
  const hashBytes = options.hashBytes ?? new Uint8Array(32).fill(0xab);
  const hash = toHex(hashBytes).toUpperCase();
  const sender = toBech32('manifest', new Uint8Array(20).fill(1));
  const recipient = toBech32('manifest', new Uint8Array(20).fill(2));
  const messages: readonly EncodeObject[] = [
    {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: sender,
        toAddress: recipient,
        amount: [{ denom: 'umfx', amount: '1' }],
      },
    },
  ];
  const fee: StdFee = {
    amount: [{ denom: 'umfx', amount: '1' }],
    gas: '100000',
  };
  const checkTx = {
    code: 0,
    hash: hashBytes,
    events: [],
    gasUsed: 0n,
    gasWanted: 0n,
  } satisfies Awaited<ReturnType<CometClient['broadcastTxSync']>>;
  const comet = {
    broadcastTxSync: vi
      .fn<CometClient['broadcastTxSync']>()
      .mockResolvedValue(checkTx),
    txSearchAll: vi.fn<CometClient['txSearchAll']>().mockResolvedValue({
      txs: [],
      totalCount: 0,
    }),
    status: vi.fn(async () => ({ nodeInfo: { network: chainId } })),
    disconnect: vi.fn<() => void>(),
  };
  const signer = {
    getAccounts: vi.fn(async () => []),
    signDirect: vi.fn(async () => {
      throw new Error('Unexpected real signing in inclusion-timeout fixture');
    }),
  } satisfies OfflineSigner;
  // A deliberately partial Comet wire: every production method exercised here
  // is present, while unexpected transport use fails instead of reaching a node.
  const client = await SigningStargateClient.createWithSigner(
    comet as unknown as CometClient,
    signer,
    {
      broadcastTimeoutMs: options.timeoutMs ?? 1,
      broadcastPollIntervalMs: options.pollIntervalMs ?? 2,
      gasPrice: GasPrice.fromString('1umfx'),
    },
  );
  const sign = vi.spyOn(client, 'sign').mockResolvedValue({
    bodyBytes: new Uint8Array(),
    authInfoBytes: new Uint8Array(),
    signatures: [],
  });
  return {
    client,
    comet,
    sign,
    signer,
    hash,
    sender,
    messages,
    fee,
    chainId,
    checkTx,
    installGuard: () => installBroadcastFailureGuard(client),
  };
}
