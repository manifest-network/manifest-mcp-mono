import { describe, expect, it } from 'vitest';
import { buildTokenfactoryMessages } from './tokenfactory.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const RECIPIENT = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';
const FACTORY_DENOM = `factory/${SENDER}/foo`;

describe('buildTokenfactoryMessages', () => {
  it('builds MsgCreateDenom', () => {
    const built = buildTokenfactoryMessages(SENDER, 'create-denom', ['foo']);
    expect(built.messages[0].typeUrl).toBe(
      '/osmosis.tokenfactory.v1beta1.MsgCreateDenom',
    );
    expect(built.messages[0].value).toMatchObject({
      sender: SENDER,
      subdenom: 'foo',
    });
  });

  it('builds MsgMint', () => {
    const built = buildTokenfactoryMessages(SENDER, 'mint', [
      `1000${FACTORY_DENOM}`,
      RECIPIENT,
    ]);
    expect(built.messages[0].typeUrl).toBe(
      '/osmosis.tokenfactory.v1beta1.MsgMint',
    );
    expect(built.messages[0].value).toMatchObject({
      sender: SENDER,
      mintToAddress: RECIPIENT,
      amount: { denom: FACTORY_DENOM, amount: '1000' },
    });
  });

  it('builds MsgBurn', () => {
    const built = buildTokenfactoryMessages(SENDER, 'burn', [
      `500${FACTORY_DENOM}`,
      RECIPIENT,
    ]);
    expect(built.messages[0].typeUrl).toBe(
      '/osmosis.tokenfactory.v1beta1.MsgBurn',
    );
    expect(built.messages[0].value).toMatchObject({
      sender: SENDER,
      burnFromAddress: RECIPIENT,
      amount: { denom: FACTORY_DENOM, amount: '500' },
    });
  });

  it('builds MsgChangeAdmin', () => {
    const built = buildTokenfactoryMessages(SENDER, 'change-admin', [
      FACTORY_DENOM,
      RECIPIENT,
    ]);
    expect(built.messages[0].typeUrl).toBe(
      '/osmosis.tokenfactory.v1beta1.MsgChangeAdmin',
    );
    expect(built.messages[0].value).toMatchObject({
      sender: SENDER,
      denom: FACTORY_DENOM,
      newAdmin: RECIPIENT,
    });
  });

  it('builds MsgForceTransfer', () => {
    const built = buildTokenfactoryMessages(SENDER, 'force-transfer', [
      `1000${FACTORY_DENOM}`,
      SENDER,
      RECIPIENT,
    ]);
    expect(built.messages[0].typeUrl).toBe(
      '/osmosis.tokenfactory.v1beta1.MsgForceTransfer',
    );
    expect(built.messages[0].value).toMatchObject({
      sender: SENDER,
      transferFromAddress: SENDER,
      transferToAddress: RECIPIENT,
    });
  });

  it('builds MsgSetDenomMetadata from JSON', () => {
    const metadata = JSON.stringify({
      description: 'Test',
      denomUnits: [{ denom: FACTORY_DENOM, exponent: 0, aliases: [] }],
      base: FACTORY_DENOM,
      display: FACTORY_DENOM,
      name: 'Foo',
      symbol: 'FOO',
    });
    const built = buildTokenfactoryMessages(SENDER, 'set-denom-metadata', [
      metadata,
    ]);
    expect(built.messages[0].typeUrl).toBe(
      '/osmosis.tokenfactory.v1beta1.MsgSetDenomMetadata',
    );
  });

  it('builds MsgUpdateParams from JSON', () => {
    const params = JSON.stringify({
      denomCreationFee: [{ denom: 'umfx', amount: '1000000' }],
    });
    const built = buildTokenfactoryMessages(SENDER, 'update-params', [params]);
    expect(built.messages[0].typeUrl).toBe(
      '/osmosis.tokenfactory.v1beta1.MsgUpdateParams',
    );
    expect(built.messages[0].value).toMatchObject({ authority: SENDER });
  });

  it('rejects invalid JSON for update-params', () => {
    expect(() =>
      buildTokenfactoryMessages(SENDER, 'update-params', ['not-json']),
    ).toThrow(/invalid JSON/);
  });

  it('rejects update-params with null', () => {
    expect(() =>
      buildTokenfactoryMessages(SENDER, 'update-params', ['null']),
    ).toThrow();
  });

  it('rejects update-params with typo (unknown key)', () => {
    const badJson = JSON.stringify({ denomCreationFees: [] });
    expect(() =>
      buildTokenfactoryMessages(SENDER, 'update-params', [badJson]),
    ).toThrow(/denomCreationFees/);
  });

  it('rejects set-denom-metadata with missing required field', () => {
    // `base` is required; missing it triggers a schema error.
    const bad = JSON.stringify({
      denomUnits: [{ denom: FACTORY_DENOM, exponent: 0 }],
      display: FACTORY_DENOM,
    });
    expect(() =>
      buildTokenfactoryMessages(SENDER, 'set-denom-metadata', [bad]),
    ).toThrow(/base/);
  });

  it('rejects set-denom-metadata with empty denomUnits', () => {
    const bad = JSON.stringify({
      denomUnits: [],
      base: FACTORY_DENOM,
      display: FACTORY_DENOM,
    });
    expect(() =>
      buildTokenfactoryMessages(SENDER, 'set-denom-metadata', [bad]),
    ).toThrow(/denomUnits/);
  });

  it('throws on unknown subcommand', () => {
    expect(() =>
      buildTokenfactoryMessages(SENDER, 'nonexistent', []),
    ).toThrow();
  });

  it('rejects mint with invalid amount', () => {
    expect(() =>
      buildTokenfactoryMessages(SENDER, 'mint', ['not-an-amount', RECIPIENT]),
    ).toThrow();
  });

  it('rejects mint with invalid recipient address', () => {
    expect(() =>
      buildTokenfactoryMessages(SENDER, 'mint', [
        `1000${FACTORY_DENOM}`,
        'not-an-address',
      ]),
    ).toThrow();
  });
});
