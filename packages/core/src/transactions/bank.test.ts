import { describe, expect, it, vi } from 'vitest';
import { routeBankTransaction } from './bank.js';

// Valid bech32 addresses for testing
const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const RECIPIENT = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';

function makeMockSigningClient() {
  return {
    signAndBroadcast: vi.fn().mockResolvedValue({
      code: 0,
      transactionHash: 'ABCD1234',
      height: 100,
      gasUsed: 50000n,
      gasWanted: 100000n,
    }),
  } as any;
}

describe('routeBankTransaction', () => {
  it('routes send subcommand', async () => {
    const client = makeMockSigningClient();
    const result = await routeBankTransaction(
      client,
      SENDER,
      'send',
      [RECIPIENT, '1000umfx'],
      true,
    );

    expect(result.module).toBe('bank');
    expect(result.subcommand).toBe('send');
    expect(result.transactionHash).toBe('ABCD1234');
    expect(client.signAndBroadcast).toHaveBeenCalledOnce();

    const [senderAddr, msgs] = client.signAndBroadcast.mock.calls[0];
    expect(senderAddr).toBe(SENDER);
    expect(msgs[0].typeUrl).toBe('/cosmos.bank.v1beta1.MsgSend');
  });

  it('send with --memo flag', async () => {
    const client = makeMockSigningClient();
    await routeBankTransaction(
      client,
      SENDER,
      'send',
      [RECIPIENT, '1000umfx', '--memo', 'hello'],
      true,
    );

    const memo = client.signAndBroadcast.mock.calls[0][3];
    expect(memo).toBe('hello');
  });

  it('routes multi-send subcommand', async () => {
    const client = makeMockSigningClient();
    const result = await routeBankTransaction(
      client,
      SENDER,
      'multi-send',
      [`${RECIPIENT}:500umfx`],
      true,
    );

    expect(result.module).toBe('bank');
    expect(result.subcommand).toBe('multi-send');
    const msgs = client.signAndBroadcast.mock.calls[0][1];
    expect(msgs[0].typeUrl).toBe('/cosmos.bank.v1beta1.MsgMultiSend');
  });

  it('throws on unsupported subcommand', async () => {
    const client = makeMockSigningClient();
    await expect(
      routeBankTransaction(client, SENDER, 'burn', [], true),
    ).rejects.toThrow();
  });

  it('throws when send args are missing', async () => {
    const client = makeMockSigningClient();
    await expect(
      routeBankTransaction(client, SENDER, 'send', [RECIPIENT], true),
    ).rejects.toThrow();
  });
});
