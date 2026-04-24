import { describe, expect, it } from 'vitest';
import { buildPoAMessages } from './poa.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const VALIDATOR = 'manifestvaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0apzj780';

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
});
