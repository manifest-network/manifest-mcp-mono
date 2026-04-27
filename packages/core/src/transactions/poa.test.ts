import { fromBase64 } from '@cosmjs/encoding';
import { describe, expect, it } from 'vitest';
import { buildPoAMessages } from './poa.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const VALIDATOR = 'manifestvaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0apzj780';
// Sender and VALIDATOR share the same underlying account bytes — the route
// derives `delegatorAddress` from the validator bytes when omitted, so the
// derived value must equal SENDER.
const PUBKEY_BASE64 = 'CiECrIfPQYJZNFRJoNVoyAv9d5+vh+xMtUdQ54sXwS5dBE0=';

function buildCreateValidatorJson(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    description: { moniker: 'val-1' },
    commission: { rate: '0.1', maxRate: '0.2', maxChangeRate: '0.01' },
    minSelfDelegation: '1',
    validatorAddress: VALIDATOR,
    pubkey: {
      typeUrl: '/cosmos.crypto.ed25519.PubKey',
      value: PUBKEY_BASE64,
    },
    ...overrides,
  });
}

describe('buildPoAMessages', () => {
  it('builds MsgSetPower', () => {
    const built = buildPoAMessages(SENDER, 'set-power', [VALIDATOR, '1000']);
    expect(built.messages).toHaveLength(1);
    expect(built.messages[0].typeUrl).toBe(
      '/strangelove_ventures.poa.v1.MsgSetPower',
    );
    expect(built.messages[0].value).toMatchObject({
      sender: SENDER,
      validatorAddress: VALIDATOR,
      power: BigInt(1000),
      unsafe: false,
    });
  });

  it('honors --unsafe flag on set-power', () => {
    const built = buildPoAMessages(SENDER, 'set-power', [
      VALIDATOR,
      '1000',
      '--unsafe',
    ]);
    expect(built.messages[0].value).toMatchObject({ unsafe: true });
  });

  it('builds MsgRemoveValidator', () => {
    const built = buildPoAMessages(SENDER, 'remove-validator', [VALIDATOR]);
    expect(built.messages[0].typeUrl).toBe(
      '/strangelove_ventures.poa.v1.MsgRemoveValidator',
    );
    expect(built.messages[0].value).toMatchObject({
      sender: SENDER,
      validatorAddress: VALIDATOR,
    });
  });

  it('builds MsgRemovePending', () => {
    const built = buildPoAMessages(SENDER, 'remove-pending', [VALIDATOR]);
    expect(built.messages[0].typeUrl).toBe(
      '/strangelove_ventures.poa.v1.MsgRemovePending',
    );
  });

  it('builds MsgUpdateStakingParams from JSON', () => {
    const paramsJson = JSON.stringify({
      unbondingTime: { seconds: '1209600', nanos: 0 },
      maxValidators: 100,
      maxEntries: 7,
      historicalEntries: 10000,
      bondDenom: 'umfx',
      minCommissionRate: '0',
    });
    const built = buildPoAMessages(SENDER, 'update-staking-params', [
      paramsJson,
    ]);
    expect(built.messages[0].typeUrl).toBe(
      '/strangelove_ventures.poa.v1.MsgUpdateStakingParams',
    );
    expect(built.messages[0].value).toMatchObject({ sender: SENDER });
  });

  it('rejects invalid JSON for update-staking-params', () => {
    expect(() =>
      buildPoAMessages(SENDER, 'update-staking-params', ['not json']),
    ).toThrow(/invalid JSON/);
  });

  it('rejects update-staking-params with null', () => {
    expect(() =>
      buildPoAMessages(SENDER, 'update-staking-params', ['null']),
    ).toThrow();
  });

  it('rejects update-staking-params with array', () => {
    expect(() =>
      buildPoAMessages(SENDER, 'update-staking-params', ['[1,2,3]']),
    ).toThrow();
  });

  it('rejects update-staking-params with typo (unknown key)', () => {
    // Catches the silent-field-drop footgun: `unbondingTim` would be dropped
    // by fromPartial and broadcast as a zero-valued `unbondingTime`.
    const badJson = JSON.stringify({
      unbondingTim: { seconds: '1209600', nanos: 0 },
      maxValidators: 100,
      maxEntries: 7,
      historicalEntries: 10000,
      bondDenom: 'umfx',
      minCommissionRate: '0',
    });
    expect(() =>
      buildPoAMessages(SENDER, 'update-staking-params', [badJson]),
    ).toThrow(/unbondingTim/);
  });

  it('rejects update-staking-params with missing required field', () => {
    const badJson = JSON.stringify({
      unbondingTime: { seconds: '1209600', nanos: 0 },
      maxValidators: 100,
      maxEntries: 7,
      historicalEntries: 10000,
      // bondDenom missing
      minCommissionRate: '0',
    });
    expect(() =>
      buildPoAMessages(SENDER, 'update-staking-params', [badJson]),
    ).toThrow(/bondDenom/);
  });

  // Pins the bigintFromJson tightening: strings must be decimal integers.
  // Without the regex, BigInt("") returns 0n, BigInt("0x10") returns 16n, and
  // "  10  " / "1e10" each produce surprising values — reintroducing the
  // zero-valued-field footgun these schemas were written to prevent.
  it.each([
    ['empty string', ''],
    ['whitespace', '  '],
    ['hex literal', '0x10'],
    ['scientific notation', '1e10'],
    ['decimal', '1.5'],
  ])('rejects update-staking-params when unbondingTime.seconds is %s', (_label, seconds) => {
    const badJson = JSON.stringify({
      unbondingTime: { seconds, nanos: 0 },
      maxValidators: 100,
      maxEntries: 7,
      historicalEntries: 10000,
      bondDenom: 'umfx',
      minCommissionRate: '0',
    });
    expect(() =>
      buildPoAMessages(SENDER, 'update-staking-params', [badJson]),
    ).toThrow(/unbondingTime\.seconds/);
  });

  it('rejects update-staking-params when unbondingTime.seconds is a JS number (precision-loss guard)', () => {
    const badJson = JSON.stringify({
      unbondingTime: { seconds: 1209600, nanos: 0 },
      maxValidators: 100,
      maxEntries: 7,
      historicalEntries: 10000,
      bondDenom: 'umfx',
      minCommissionRate: '0',
    });
    expect(() =>
      buildPoAMessages(SENDER, 'update-staking-params', [badJson]),
    ).toThrow(/unbondingTime\.seconds/);
  });

  it('throws on unknown subcommand', () => {
    expect(() => buildPoAMessages(SENDER, 'nonexistent', [])).toThrow();
  });

  it('rejects set-power with missing args', () => {
    expect(() => buildPoAMessages(SENDER, 'set-power', [VALIDATOR])).toThrow();
  });

  it('rejects set-power with invalid validator address', () => {
    expect(() =>
      buildPoAMessages(SENDER, 'set-power', ['not-an-address', '1000']),
    ).toThrow();
  });

  it('rejects set-power when passed a wallet-prefix address instead of valoper', () => {
    // SENDER is "manifest1..."; using it as the validator target is a common
    // mistake that the chain would reject with an opaque error — we catch it
    // locally by deriving the valoper prefix from the sender.
    expect(() =>
      buildPoAMessages(SENDER, 'set-power', [SENDER, '1000']),
    ).toThrow(/manifestvaloper/);
  });

  it('rejects remove-validator when passed a wallet-prefix address', () => {
    expect(() =>
      buildPoAMessages(SENDER, 'remove-validator', [SENDER]),
    ).toThrow(/manifestvaloper/);
  });

  it('rejects remove-pending when passed a wallet-prefix address', () => {
    expect(() => buildPoAMessages(SENDER, 'remove-pending', [SENDER])).toThrow(
      /manifestvaloper/,
    );
  });

  describe('create-validator', () => {
    it('builds MsgCreateValidator with derived delegator address', () => {
      const built = buildPoAMessages(SENDER, 'create-validator', [
        buildCreateValidatorJson(),
      ]);
      expect(built.messages[0].typeUrl).toBe(
        '/strangelove_ventures.poa.v1.MsgCreateValidator',
      );
      const value = built.messages[0].value as {
        validatorAddress: string;
        delegatorAddress: string;
        minSelfDelegation: string;
        description: { moniker: string };
        commission: { rate: string };
        pubkey: { typeUrl: string; value: Uint8Array };
      };
      expect(value.validatorAddress).toBe(VALIDATOR);
      // delegatorAddress is derived from validator bytes with the wallet prefix
      // (manifest); these bech32 forms share the same underlying account.
      expect(value.delegatorAddress).toBe(SENDER);
      expect(value.minSelfDelegation).toBe('1');
      expect(value.description.moniker).toBe('val-1');
      expect(value.pubkey.typeUrl).toBe('/cosmos.crypto.ed25519.PubKey');
      // pubkey.value must round-trip to the original base64 bytes — guards
      // against any future regression where the route forgets to base64-decode
      // and Any.encode emits malformed bytes.
      expect(value.pubkey.value).toEqual(fromBase64(PUBKEY_BASE64));
    });

    it('honors caller-supplied delegatorAddress', () => {
      const built = buildPoAMessages(SENDER, 'create-validator', [
        buildCreateValidatorJson({ delegatorAddress: SENDER }),
      ]);
      expect(built.messages[0].value).toMatchObject({
        delegatorAddress: SENDER,
      });
    });

    it('rejects invalid JSON', () => {
      expect(() =>
        buildPoAMessages(SENDER, 'create-validator', ['not json']),
      ).toThrow(/invalid JSON/);
    });

    it('rejects unknown keys (e.g. typo "descripton")', () => {
      // Catches the silent-field-drop footgun before it reaches fromPartial.
      const bad = JSON.stringify({
        descripton: { moniker: 'val-1' },
        commission: { rate: '0.1', maxRate: '0.2', maxChangeRate: '0.01' },
        minSelfDelegation: '1',
        validatorAddress: VALIDATOR,
        pubkey: {
          typeUrl: '/cosmos.crypto.ed25519.PubKey',
          value: PUBKEY_BASE64,
        },
      });
      expect(() => buildPoAMessages(SENDER, 'create-validator', [bad])).toThrow(
        /descripton/,
      );
    });

    it('rejects missing required field (commission)', () => {
      const bad = JSON.stringify({
        description: { moniker: 'val-1' },
        // commission missing
        minSelfDelegation: '1',
        validatorAddress: VALIDATOR,
        pubkey: {
          typeUrl: '/cosmos.crypto.ed25519.PubKey',
          value: PUBKEY_BASE64,
        },
      });
      expect(() => buildPoAMessages(SENDER, 'create-validator', [bad])).toThrow(
        /commission/,
      );
    });

    it('rejects non-decimal commission rate', () => {
      expect(() =>
        buildPoAMessages(SENDER, 'create-validator', [
          buildCreateValidatorJson({
            commission: { rate: 'abc', maxRate: '0.2', maxChangeRate: '0.01' },
          }),
        ]),
      ).toThrow(/commission\.rate/);
    });

    it('rejects non-decimal-integer minSelfDelegation', () => {
      expect(() =>
        buildPoAMessages(SENDER, 'create-validator', [
          buildCreateValidatorJson({ minSelfDelegation: '1.5' }),
        ]),
      ).toThrow(/minSelfDelegation/);
    });

    it('rejects validatorAddress without valoper prefix', () => {
      expect(() =>
        buildPoAMessages(SENDER, 'create-validator', [
          buildCreateValidatorJson({ validatorAddress: SENDER }),
        ]),
      ).toThrow(/manifestvaloper/);
    });

    it('rejects invalid base64 pubkey value', () => {
      expect(() =>
        buildPoAMessages(SENDER, 'create-validator', [
          buildCreateValidatorJson({
            pubkey: {
              typeUrl: '/cosmos.crypto.ed25519.PubKey',
              value: '!!!not base64!!!',
            },
          }),
        ]),
      ).toThrow(/invalid base64/);
    });

    it('rejects unknown nested key in description', () => {
      expect(() =>
        buildPoAMessages(SENDER, 'create-validator', [
          buildCreateValidatorJson({
            description: { moniker: 'val-1', wbsite: 'oops' },
          }),
        ]),
      ).toThrow(/wbsite/);
    });
  });
});
