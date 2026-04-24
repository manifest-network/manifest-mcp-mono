import { describe, expect, it } from 'vitest';
import { buildIbcTransferMessages } from './ibc-transfer.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const RECEIVER = 'cosmos1am058pdux3hyulcmfgj4m3hhrlfn8nzmxmtpvn';

describe('buildIbcTransferMessages', () => {
  it('builds MsgTransfer with default timeout', () => {
    const built = buildIbcTransferMessages(SENDER, 'transfer', [
      'transfer',
      'channel-0',
      RECEIVER,
      '1000umfx',
    ]);
    expect(built.messages).toHaveLength(1);
    expect(built.messages[0].typeUrl).toBe(
      '/ibc.applications.transfer.v1.MsgTransfer',
    );
    const value = built.messages[0].value as {
      sourcePort: string;
      sourceChannel: string;
      token: { denom: string; amount: string };
      sender: string;
      receiver: string;
      timeoutTimestamp: bigint;
    };
    expect(value).toMatchObject({
      sourcePort: 'transfer',
      sourceChannel: 'channel-0',
      token: { denom: 'umfx', amount: '1000' },
      sender: SENDER,
      receiver: RECEIVER,
    });
    // Default timestamp is set to ~10min in the future.
    expect(value.timeoutTimestamp).toBeGreaterThan(BigInt(0));
  });

  it('honors --memo flag', () => {
    const built = buildIbcTransferMessages(SENDER, 'transfer', [
      'transfer',
      'channel-0',
      RECEIVER,
      '1000umfx',
      '--memo',
      'hello',
    ]);
    expect(built.memo).toBe('hello');
  });

  it('honors --timeout-height', () => {
    const built = buildIbcTransferMessages(SENDER, 'transfer', [
      'transfer',
      'channel-0',
      RECEIVER,
      '1000umfx',
      '--timeout-height',
      '1-1000',
    ]);
    const value = built.messages[0].value as {
      timeoutHeight: { revisionNumber: bigint; revisionHeight: bigint };
      timeoutTimestamp: bigint;
    };
    expect(value.timeoutHeight.revisionNumber).toBe(BigInt(1));
    expect(value.timeoutHeight.revisionHeight).toBe(BigInt(1000));
    // When timeout-height is specified without timeout-timestamp, timestamp stays 0.
    expect(value.timeoutTimestamp).toBe(BigInt(0));
  });

  it('honors --timeout-timestamp', () => {
    const built = buildIbcTransferMessages(SENDER, 'transfer', [
      'transfer',
      'channel-0',
      RECEIVER,
      '1000umfx',
      '--timeout-timestamp',
      '123456789000000000',
    ]);
    const value = built.messages[0].value as { timeoutTimestamp: bigint };
    expect(value.timeoutTimestamp).toBe(BigInt('123456789000000000'));
  });

  it('rejects malformed --timeout-height', () => {
    expect(() =>
      buildIbcTransferMessages(SENDER, 'transfer', [
        'transfer',
        'channel-0',
        RECEIVER,
        '1000umfx',
        '--timeout-height',
        'not-valid',
      ]),
    ).toThrow(/revision-number/);
  });

  it('throws on unknown subcommand', () => {
    expect(() => buildIbcTransferMessages(SENDER, 'nonexistent', [])).toThrow();
  });

  it('rejects transfer with missing receiver', () => {
    expect(() =>
      buildIbcTransferMessages(SENDER, 'transfer', ['transfer', 'channel-0']),
    ).toThrow();
  });
});
