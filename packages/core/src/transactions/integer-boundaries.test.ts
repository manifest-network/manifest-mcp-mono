import { cosmos } from '@manifest-network/manifestjs/dist/codegen/cosmos/bundle.js';
import { cosmwasm } from '@manifest-network/manifestjs/dist/codegen/cosmwasm/bundle.js';
import { liftedinit } from '@manifest-network/manifestjs/dist/codegen/liftedinit/bundle.js';
import { strangelove_ventures as poa } from '@manifest-network/manifestjs/dist/codegen/strangelove_ventures/bundle.js';
import { describe, expect, it } from 'vitest';
import { ManifestMCPError } from '../types.js';
import { buildBillingMessages } from './billing.js';
import { buildGovMessages } from './gov.js';
import { buildGroupMessages } from './group.js';
import { buildIbcTransferMessages } from './ibc-transfer.js';
import { BankMetadataSchema, PoAStakingParamsSchema } from './json-schemas.js';
import { buildPoAMessages } from './poa.js';
import { parseAmount } from './utils.js';
import { buildWasmMessages } from './wasm.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const VALIDATOR = 'manifestvaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0apzj780';
const SKU = '11111111-1111-4111-8111-111111111111';
const UINT64_MAX = '18446744073709551615';
const INVALID_UINT64 = [
  '-1',
  '18446744073709551616',
  '18446744073709551617',
  '0x10',
  '+1',
  ' 1',
  '1 ',
  '1e2',
  '1.5',
];

describe('transaction integer wire boundaries', () => {
  const builders = [
    ['gov vote', (id: string) => buildGovMessages(SENDER, 'vote', [id, 'yes'])],
    [
      'gov deposit',
      (id: string) => buildGovMessages(SENDER, 'deposit', [id, '1umfx']),
    ],
    ['group exec', (id: string) => buildGroupMessages(SENDER, 'exec', [id])],
    [
      'wasm instantiate',
      (id: string) =>
        buildWasmMessages(SENDER, 'instantiate', [id, '{}', 'test']),
    ],
    [
      'lease quantity',
      (id: string) =>
        buildBillingMessages(SENDER, 'create-lease', [`${SKU}:${id}`]),
    ],
    [
      'poa power',
      (id: string) => buildPoAMessages(SENDER, 'set-power', [VALIDATOR, id]),
    ],
    [
      'IBC timestamp',
      (id: string) =>
        buildIbcTransferMessages(SENDER, 'transfer', [
          'transfer',
          'channel-0',
          SENDER,
          '1umfx',
          '--timeout-timestamp',
          id,
        ]),
    ],
  ] as const;

  for (const [name, build] of builders) {
    it.each(INVALID_UINT64)(
      `${name} rejects %s before encoding or broadcast`,
      (input) => {
        expect(() => build(input)).toThrow(ManifestMCPError);
      },
    );
  }

  it.each(['0', '1', '9007199254740993', UINT64_MAX])(
    'governance IDs survive the actual codec at %s',
    (id) => {
      const message = buildGovMessages(SENDER, 'vote', [id, 'yes']).messages[0];
      const codec = cosmos.gov.v1.MsgVote;
      expect(
        codec
          .decode(codec.encode(message.value).finish())
          .proposalId.toString(),
      ).toBe(id);
    },
  );

  it('preserves maximum uint64 on lease and Wasm wire fields', () => {
    const lease = buildBillingMessages(SENDER, 'create-lease', [
      `${SKU}:${UINT64_MAX}`,
    ]).messages[0];
    const leaseCodec = liftedinit.billing.v1.MsgCreateLease;
    expect(
      leaseCodec
        .decode(leaseCodec.encode(lease.value).finish())
        .items[0].quantity.toString(),
    ).toBe(UINT64_MAX);
    const wasm = buildWasmMessages(SENDER, 'instantiate', [
      UINT64_MAX,
      '{}',
      'test',
    ]).messages[0];
    const wasmCodec = cosmwasm.wasm.v1.MsgInstantiateContract;
    expect(
      wasmCodec.decode(wasmCodec.encode(wasm.value).finish()).codeId.toString(),
    ).toBe(UINT64_MAX);
  });

  it('does not impose uint64 limits on arbitrary-precision coin amounts', () => {
    const amount = '1844674407370955161700000000000000000000';
    expect(parseAmount(`${amount}umfx`)).toEqual({ amount, denom: 'umfx' });
  });

  const staking = {
    unbondingTime: { seconds: '315576000000' },
    maxValidators: 4_294_967_295,
    maxEntries: 4_294_967_295,
    historicalEntries: 4_294_967_295,
    bondDenom: 'umfx',
    minCommissionRate: '0',
  };

  it('preserves maximum uint32 and Duration values through the real PoA codec', () => {
    const message = buildPoAMessages(SENDER, 'update-staking-params', [
      JSON.stringify(staking),
    ]).messages[0];
    const codec = poa.poa.v1.MsgUpdateStakingParams;
    const decoded = codec.decode(codec.encode(message.value).finish());
    expect(decoded.params.maxValidators).toBe(4_294_967_295);
    expect(decoded.params.unbondingTime.seconds).toBe(315_576_000_000n);
  });

  it.each(['maxValidators', 'maxEntries', 'historicalEntries'])(
    'rejects uint32 overflow in %s',
    (field) => {
      expect(
        PoAStakingParamsSchema.safeParse({ ...staking, [field]: 4_294_967_296 })
          .success,
      ).toBe(false);
    },
  );

  it('rejects Duration overflow and bank denomination exponent overflow', () => {
    expect(
      PoAStakingParamsSchema.safeParse({
        ...staking,
        unbondingTime: { seconds: '315576000001' },
      }).success,
    ).toBe(false);
    expect(
      BankMetadataSchema.safeParse({
        base: 'umfx',
        display: 'mfx',
        denomUnits: [{ denom: 'mfx', exponent: 4_294_967_296 }],
      }).success,
    ).toBe(false);
  });
});
