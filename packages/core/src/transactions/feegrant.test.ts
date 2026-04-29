import { cosmos } from '@manifest-network/manifestjs';
import { describe, expect, it, vi } from 'vitest';
import { buildFeegrantMessages, routeFeegrantTransaction } from './feegrant.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const GRANTEE = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';

function makeMockSigningClient() {
  return {
    signAndBroadcast: vi.fn().mockResolvedValue({
      code: 0,
      transactionHash: 'ABCD1234',
      height: 100,
      gasUsed: 50000n,
      gasWanted: 100000n,
    }),
  } as unknown as Parameters<typeof routeFeegrantTransaction>[0];
}

describe('buildFeegrantMessages', () => {
  describe('grant-allowance', () => {
    it('builds MsgGrantAllowance with an unlimited BasicAllowance', () => {
      const built = buildFeegrantMessages(SENDER, 'grant-allowance', [GRANTEE]);
      expect(built.messages).toHaveLength(1);
      const [msg] = built.messages;
      expect(msg.typeUrl).toBe('/cosmos.feegrant.v1beta1.MsgGrantAllowance');
      expect(msg.value.granter).toBe(SENDER);
      expect(msg.value.grantee).toBe(GRANTEE);
      expect(msg.value.allowance.$typeUrl).toBe(
        '/cosmos.feegrant.v1beta1.BasicAllowance',
      );
      expect(msg.value.allowance.spendLimit).toEqual([]);
      expect(msg.value.allowance.expiration).toBeUndefined();
    });

    it('parses --spend-limit into a Coin array', () => {
      const built = buildFeegrantMessages(SENDER, 'grant-allowance', [
        GRANTEE,
        '--spend-limit',
        '1000000umfx',
      ]);
      const [msg] = built.messages;
      expect(msg.value.allowance.spendLimit).toEqual([
        { denom: 'umfx', amount: '1000000' },
      ]);
    });

    it('parses --expiration into a Date', () => {
      const built = buildFeegrantMessages(SENDER, 'grant-allowance', [
        GRANTEE,
        '--expiration',
        '2000000000',
      ]);
      const [msg] = built.messages;
      expect(msg.value.allowance.expiration).toBeInstanceOf(Date);
      expect(msg.value.allowance.expiration.getTime()).toBe(2000000000 * 1000);
    });

    it('encodes round-trip through MsgGrantAllowance.encode', () => {
      const built = buildFeegrantMessages(SENDER, 'grant-allowance', [
        GRANTEE,
        '--spend-limit',
        '1000umfx',
      ]);
      const [msg] = built.messages;
      const bytes = cosmos.feegrant.v1beta1.MsgGrantAllowance.encode(
        msg.value,
      ).finish();
      const decoded = cosmos.feegrant.v1beta1.MsgGrantAllowance.decode(bytes);
      expect(decoded.granter).toBe(SENDER);
      expect(decoded.grantee).toBe(GRANTEE);
      const allowance = decoded.allowance as {
        $typeUrl: string;
        spendLimit: { denom: string; amount: string }[];
      };
      expect(allowance?.$typeUrl).toBe(
        '/cosmos.feegrant.v1beta1.BasicAllowance',
      );
      expect(allowance?.spendLimit).toEqual([
        { denom: 'umfx', amount: '1000' },
      ]);
    });

    it('rejects invalid grantee address', () => {
      expect(() =>
        buildFeegrantMessages(SENDER, 'grant-allowance', ['nope']),
      ).toThrow(/grantee address/i);
    });

    it('requires the grantee positional arg', () => {
      expect(() =>
        buildFeegrantMessages(SENDER, 'grant-allowance', []),
      ).toThrow(/requires 1/i);
    });

    it('rejects bad amount format on --spend-limit', () => {
      expect(() =>
        buildFeegrantMessages(SENDER, 'grant-allowance', [
          GRANTEE,
          '--spend-limit',
          'not-an-amount',
        ]),
      ).toThrow(/amount/i);
    });
  });

  describe('revoke-allowance', () => {
    it('builds MsgRevokeAllowance', () => {
      const built = buildFeegrantMessages(SENDER, 'revoke-allowance', [
        GRANTEE,
      ]);
      const [msg] = built.messages;
      expect(msg.typeUrl).toBe('/cosmos.feegrant.v1beta1.MsgRevokeAllowance');
      expect(msg.value.granter).toBe(SENDER);
      expect(msg.value.grantee).toBe(GRANTEE);
    });

    it('rejects invalid grantee', () => {
      expect(() =>
        buildFeegrantMessages(SENDER, 'revoke-allowance', ['x']),
      ).toThrow(/grantee address/i);
    });

    it('requires grantee', () => {
      expect(() =>
        buildFeegrantMessages(SENDER, 'revoke-allowance', []),
      ).toThrow(/requires 1/i);
    });
  });

  describe('prune-allowances', () => {
    it('builds MsgPruneAllowances with the sender as pruner', () => {
      const built = buildFeegrantMessages(SENDER, 'prune-allowances', []);
      const [msg] = built.messages;
      expect(msg.typeUrl).toBe('/cosmos.feegrant.v1beta1.MsgPruneAllowances');
      expect(msg.value.pruner).toBe(SENDER);
    });
  });

  it('throws on unsupported subcommand', () => {
    expect(() => buildFeegrantMessages(SENDER, 'frobnicate', [])).toThrow();
  });
});

describe('routeFeegrantTransaction', () => {
  it('signs and broadcasts a grant-allowance', async () => {
    const client = makeMockSigningClient();
    const result = await routeFeegrantTransaction(
      client,
      SENDER,
      'grant-allowance',
      [GRANTEE],
      true,
    );
    expect(result.module).toBe('feegrant');
    expect(result.subcommand).toBe('grant-allowance');
    const [signer, msgs] = (
      client.signAndBroadcast as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(signer).toBe(SENDER);
    expect(msgs[0].typeUrl).toBe('/cosmos.feegrant.v1beta1.MsgGrantAllowance');
  });
});
