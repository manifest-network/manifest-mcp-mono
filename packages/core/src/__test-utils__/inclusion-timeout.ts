import { sha256 } from '@cosmjs/crypto';
import { toBech32, toHex } from '@cosmjs/encoding';
import type { EncodeObject } from '@cosmjs/proto-signing';
import {
  GasPrice,
  type SignerData,
  SigningStargateClient,
  type StdFee,
} from '@cosmjs/stargate';
import { type Mock, vi } from 'vitest';
import { installBroadcastFailureGuard } from '../internals/broadcast-failure.js';

type CometClient = Parameters<typeof SigningStargateClient.createWithSigner>[0];
// In the pinned client union, only Comet 0.38's commit response has txResult.
// Select that concrete member through our declared stargate dependency.
type Comet38Member<Client extends CometClient> = Client extends CometClient
  ? 'txResult' extends keyof Awaited<ReturnType<Client['broadcastTxCommit']>>
    ? Client
    : never
  : never;
type IsUnion<Member, Whole = Member> = Member extends Whole
  ? [Whole] extends [Member]
    ? false
    : true
  : never;
// Fail the wire check if an upstream change leaves zero or multiple matches.
type SingleMember<Member> = [Member] extends [never]
  ? never
  : IsUnion<Member> extends false
    ? Member
    : never;
type Comet38Client = SingleMember<Comet38Member<CometClient>>;
type OfflineSigner = Parameters<
  typeof SigningStargateClient.createWithSigner
>[1];

// Keep the exported mocks on small local wire contracts. Inferring them from
// CometClient's protocol union or the sign spy makes declaration generation
// vendor transitive Tendermint/protobuf types into this test utility's package.
interface FixtureTxData {
  readonly code: number;
  readonly codespace?: string;
  readonly log?: string;
  readonly data?: Uint8Array;
  readonly events: readonly {
    readonly type: string;
    readonly attributes: readonly {
      readonly key: string;
      readonly value: string;
    }[];
  }[];
  readonly gasUsed: bigint;
  readonly gasWanted: bigint;
}

type FixtureBroadcastTxSync = (params: {
  readonly tx: Uint8Array;
}) => Promise<FixtureTxData & { readonly hash: Uint8Array }>;

type FixtureTxSearchAll = (params: { readonly query: string }) => Promise<{
  readonly txs: readonly {
    readonly tx: Uint8Array;
    readonly hash: Uint8Array;
    readonly height: number;
    readonly index: number;
    readonly result: FixtureTxData;
  }[];
  readonly totalCount: number;
}>;

type FixtureSign = (
  signerAddress: string,
  messages: readonly EncodeObject[],
  fee: StdFee,
  memo: string,
  explicitSignerData?: SignerData,
  timeoutHeight?: bigint,
) => Promise<{
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  signatures: Uint8Array[];
}>;

export interface InclusionTimeoutFixtureOptions {
  /** Override the RPC-reported hash to exercise malformed or mismatched responses. */
  readonly hashBytes?: Uint8Array;
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
  const chainId = 'test-chain';
  // The default mocked TxRaw below encodes to empty bytes. Each wire call still
  // hashes its actual input so direct broadcasts with other bytes remain honest.
  const hashBytes = sha256(new Uint8Array());
  const hash = toHex(hashBytes).toUpperCase();
  const reportedHash = toHex(options.hashBytes ?? hashBytes).toUpperCase();
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
    hash: options.hashBytes ?? hashBytes,
    events: [],
    gasUsed: 0n,
    gasWanted: 0n,
  } satisfies Awaited<ReturnType<FixtureBroadcastTxSync>>;
  const comet = {
    broadcastTxSync: vi
      .fn<FixtureBroadcastTxSync>()
      .mockImplementation(async ({ tx }) => ({
        ...checkTx,
        hash: options.hashBytes ?? sha256(tx),
      })),
    txSearchAll: vi.fn<FixtureTxSearchAll>().mockResolvedValue({
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
  // Check broadcastTxSync and txSearchAll against Comet 0.38, whose event
  // attributes are strings, without leaking protocol types into declarations.
  // Other wire methods are deliberately partial; no mock can reach a node.
  const client = await SigningStargateClient.createWithSigner(
    comet satisfies Pick<
      Comet38Client,
      'broadcastTxSync' | 'txSearchAll'
    > as unknown as CometClient,
    signer,
    {
      broadcastTimeoutMs: 1,
      broadcastPollIntervalMs: 2,
      gasPrice: GasPrice.fromString('1umfx'),
    },
  );
  const sign: Mock<FixtureSign> = vi.spyOn(client, 'sign').mockResolvedValue({
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
    reportedHash,
    sender,
    messages,
    fee,
    chainId,
    checkTx,
    installGuard: () => installBroadcastFailureGuard(client),
  };
}
