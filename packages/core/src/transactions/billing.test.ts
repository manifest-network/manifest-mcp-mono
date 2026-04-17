import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { buildBillingMessages } from './billing.js';

const SENDER = 'manifest19rl4cm2hmr8afy4kldpxz3fka4jguq0aaz02ta';
const TENANT = 'manifest1am058pdux3hyulcmfgj4m3hhrlfn8nzmx97smg';

describe('buildBillingMessages — fund-credit', () => {
  it('builds MsgFundCredit with sender and explicit tenant', () => {
    const { messages } = buildBillingMessages(SENDER, 'fund-credit', [
      TENANT,
      '1000umfx',
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].typeUrl).toBe('/liftedinit.billing.v1.MsgFundCredit');
    expect(messages[0].value).toMatchObject({
      sender: SENDER,
      tenant: TENANT,
      amount: { denom: 'umfx', amount: '1000' },
    });
  });

  it('rejects invalid bech32 tenant with INVALID_ADDRESS', () => {
    try {
      buildBillingMessages(SENDER, 'fund-credit', ['not-a-bech32', '1000umfx']);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestMCPError);
      expect((e as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_ADDRESS,
      );
    }
  });

  it('rejects empty tenant with INVALID_ADDRESS', () => {
    try {
      buildBillingMessages(SENDER, 'fund-credit', ['', '1000umfx']);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestMCPError);
      expect((e as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_ADDRESS,
      );
    }
  });
});
