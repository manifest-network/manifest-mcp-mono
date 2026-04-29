import { cosmos } from '@manifest-network/manifestjs';
import { describe, expect, it, vi } from 'vitest';
import { buildAuthzMessages, routeAuthzTransaction } from './authz.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const GRANTEE = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';
const RECIPIENT = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';

const MSG_SEND_TYPE_URL = '/cosmos.bank.v1beta1.MsgSend';

function makeMockSigningClient() {
  return {
    signAndBroadcast: vi.fn().mockResolvedValue({
      code: 0,
      transactionHash: 'ABCD1234',
      height: 100,
      gasUsed: 50000n,
      gasWanted: 100000n,
    }),
  } as unknown as Parameters<typeof routeAuthzTransaction>[0];
}

describe('buildAuthzMessages', () => {
  describe('grant', () => {
    it('builds MsgGrant with GenericAuthorization (no expiration)', () => {
      const built = buildAuthzMessages(SENDER, 'grant', [
        GRANTEE,
        MSG_SEND_TYPE_URL,
      ]);
      expect(built.messages).toHaveLength(1);
      const [msg] = built.messages;
      expect(msg.typeUrl).toBe('/cosmos.authz.v1beta1.MsgGrant');
      expect(msg.value.granter).toBe(SENDER);
      expect(msg.value.grantee).toBe(GRANTEE);
      expect(msg.value.grant.authorization.$typeUrl).toBe(
        '/cosmos.authz.v1beta1.GenericAuthorization',
      );
      expect(msg.value.grant.authorization.msg).toBe(MSG_SEND_TYPE_URL);
      expect(msg.value.grant.expiration).toBeUndefined();
    });

    it('parses --expiration as a Date', () => {
      const built = buildAuthzMessages(SENDER, 'grant', [
        GRANTEE,
        MSG_SEND_TYPE_URL,
        '--expiration',
        '2000000000',
      ]);
      const [msg] = built.messages;
      expect(msg.value.grant.expiration).toBeInstanceOf(Date);
      expect(msg.value.grant.expiration.getTime()).toBe(2000000000 * 1000);
    });

    it('encodes round-trip through MsgGrant.encode', () => {
      const built = buildAuthzMessages(SENDER, 'grant', [
        GRANTEE,
        MSG_SEND_TYPE_URL,
      ]);
      const [msg] = built.messages;
      const bytes = cosmos.authz.v1beta1.MsgGrant.encode(msg.value).finish();
      const decoded = cosmos.authz.v1beta1.MsgGrant.decode(bytes);
      expect(decoded.granter).toBe(SENDER);
      expect(decoded.grantee).toBe(GRANTEE);
      const auth = decoded.grant?.authorization as {
        $typeUrl: string;
        msg: string;
      };
      expect(auth?.$typeUrl).toBe('/cosmos.authz.v1beta1.GenericAuthorization');
      expect(auth?.msg).toBe(MSG_SEND_TYPE_URL);
    });

    it('rejects invalid grantee address', () => {
      expect(() =>
        buildAuthzMessages(SENDER, 'grant', ['not-bech32', MSG_SEND_TYPE_URL]),
      ).toThrow(/grantee address/i);
    });

    it('rejects malformed msg-type-url', () => {
      expect(() =>
        buildAuthzMessages(SENDER, 'grant', [GRANTEE, 'no-leading-slash']),
      ).toThrow(/msg-type-url/i);
    });

    it('requires both positional args', () => {
      expect(() => buildAuthzMessages(SENDER, 'grant', [GRANTEE])).toThrow(
        /requires 2/i,
      );
    });
  });

  describe('revoke', () => {
    it('builds MsgRevoke', () => {
      const built = buildAuthzMessages(SENDER, 'revoke', [
        GRANTEE,
        MSG_SEND_TYPE_URL,
      ]);
      const [msg] = built.messages;
      expect(msg.typeUrl).toBe('/cosmos.authz.v1beta1.MsgRevoke');
      expect(msg.value.granter).toBe(SENDER);
      expect(msg.value.grantee).toBe(GRANTEE);
      expect(msg.value.msgTypeUrl).toBe(MSG_SEND_TYPE_URL);
    });

    it('rejects invalid grantee address', () => {
      expect(() =>
        buildAuthzMessages(SENDER, 'revoke', ['x', MSG_SEND_TYPE_URL]),
      ).toThrow(/grantee address/i);
    });

    it('rejects malformed msg-type-url', () => {
      expect(() =>
        buildAuthzMessages(SENDER, 'revoke', [GRANTEE, 'bare']),
      ).toThrow(/msg-type-url/i);
    });
  });

  describe('exec', () => {
    it('builds MsgExec with an Any-encoded inner MsgSend', () => {
      const inner = JSON.stringify({
        '@type': MSG_SEND_TYPE_URL,
        fromAddress: SENDER,
        toAddress: RECIPIENT,
        amount: [{ denom: 'umfx', amount: '1000' }],
      });
      const built = buildAuthzMessages(SENDER, 'exec', [inner]);
      const [msg] = built.messages;
      expect(msg.typeUrl).toBe('/cosmos.authz.v1beta1.MsgExec');
      expect(msg.value.grantee).toBe(SENDER);
      expect(msg.value.msgs).toHaveLength(1);
      const innerAny = msg.value.msgs[0] as {
        typeUrl: string;
        value: Uint8Array;
      };
      expect(innerAny.typeUrl).toBe(MSG_SEND_TYPE_URL);
      expect(innerAny.value).toBeInstanceOf(Uint8Array);

      const decoded = cosmos.bank.v1beta1.MsgSend.decode(innerAny.value);
      expect(decoded.fromAddress).toBe(SENDER);
      expect(decoded.toAddress).toBe(RECIPIENT);
      expect(decoded.amount).toEqual([{ denom: 'umfx', amount: '1000' }]);
    });

    it('accepts multiple inner messages', () => {
      const innerA = JSON.stringify({
        '@type': MSG_SEND_TYPE_URL,
        fromAddress: SENDER,
        toAddress: RECIPIENT,
        amount: [{ denom: 'umfx', amount: '1' }],
      });
      const innerB = JSON.stringify({
        '@type': MSG_SEND_TYPE_URL,
        fromAddress: SENDER,
        toAddress: RECIPIENT,
        amount: [{ denom: 'umfx', amount: '2' }],
      });
      const built = buildAuthzMessages(SENDER, 'exec', [innerA, innerB]);
      expect(built.messages[0].value.msgs).toHaveLength(2);
    });

    it('rejects invalid JSON', () => {
      expect(() => buildAuthzMessages(SENDER, 'exec', ['{not json'])).toThrow(
        /not valid JSON/i,
      );
    });

    it('rejects missing @type', () => {
      expect(() =>
        buildAuthzMessages(SENDER, 'exec', [
          JSON.stringify({ fromAddress: SENDER }),
        ]),
      ).toThrow(/@type/);
    });

    it('rejects unknown @type', () => {
      expect(() =>
        buildAuthzMessages(SENDER, 'exec', [
          JSON.stringify({ '@type': '/not.a.real.Msg' }),
        ]),
      ).toThrow(/unknown inner message type/i);
    });

    it('requires at least one inner message', () => {
      expect(() => buildAuthzMessages(SENDER, 'exec', [])).toThrow(
        /requires 1/i,
      );
    });
  });

  it('throws on unsupported subcommand', () => {
    expect(() => buildAuthzMessages(SENDER, 'frobnicate', [])).toThrow();
  });
});

describe('routeAuthzTransaction', () => {
  it('signs and broadcasts a grant', async () => {
    const client = makeMockSigningClient();
    const result = await routeAuthzTransaction(
      client,
      SENDER,
      'grant',
      [GRANTEE, MSG_SEND_TYPE_URL],
      true,
    );
    expect(result.module).toBe('authz');
    expect(result.subcommand).toBe('grant');
    expect(result.transactionHash).toBe('ABCD1234');
    const [signer, msgs] = (
      client.signAndBroadcast as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(signer).toBe(SENDER);
    expect(msgs[0].typeUrl).toBe('/cosmos.authz.v1beta1.MsgGrant');
  });
});
