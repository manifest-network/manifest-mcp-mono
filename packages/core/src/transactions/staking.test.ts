import { describe, expect, it, vi } from 'vitest';
import { buildStakingMessages, routeStakingTransaction } from './staking.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const VALIDATOR = 'manifestvaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0apzj780';

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

describe('buildStakingMessages', () => {
  it('returns canonicalSubcommand: "unbond" for unbond input', () => {
    const built = buildStakingMessages(SENDER, 'unbond', [
      VALIDATOR,
      '1000umfx',
    ]);
    expect(built.canonicalSubcommand).toBe('unbond');
    expect(built.messages[0].typeUrl).toBe(
      '/cosmos.staking.v1beta1.MsgUndelegate',
    );
  });

  it('returns canonicalSubcommand: "unbond" for undelegate input', () => {
    const built = buildStakingMessages(SENDER, 'undelegate', [
      VALIDATOR,
      '1000umfx',
    ]);
    expect(built.canonicalSubcommand).toBe('unbond');
    expect(built.messages[0].typeUrl).toBe(
      '/cosmos.staking.v1beta1.MsgUndelegate',
    );
  });

  it('omits canonicalSubcommand for delegate (no alias)', () => {
    const built = buildStakingMessages(SENDER, 'delegate', [
      VALIDATOR,
      '1000umfx',
    ]);
    expect(built.canonicalSubcommand).toBeUndefined();
  });

  it('omits canonicalSubcommand for redelegate (no alias)', () => {
    const built = buildStakingMessages(SENDER, 'redelegate', [
      VALIDATOR,
      VALIDATOR,
      '1000umfx',
    ]);
    expect(built.canonicalSubcommand).toBeUndefined();
  });
});

describe('routeStakingTransaction alias normalization', () => {
  it('reports subcommand: "unbond" for unbond input', async () => {
    const client = makeMockSigningClient();
    const result = await routeStakingTransaction(
      client,
      SENDER,
      'unbond',
      [VALIDATOR, '1000umfx'],
      true,
    );
    expect(result.subcommand).toBe('unbond');
  });

  it('reports subcommand: "unbond" for undelegate input', async () => {
    const client = makeMockSigningClient();
    const result = await routeStakingTransaction(
      client,
      SENDER,
      'undelegate',
      [VALIDATOR, '1000umfx'],
      true,
    );
    expect(result.subcommand).toBe('unbond');
  });
});
