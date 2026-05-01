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

const LEASE_UUID = '11111111-2222-3333-4444-555555555555';

describe('buildBillingMessages — set-item-custom-domain', () => {
  it('builds MsgSetItemCustomDomain with custom_domain set', () => {
    const { messages } = buildBillingMessages(
      SENDER,
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].typeUrl).toBe(
      '/liftedinit.billing.v1.MsgSetItemCustomDomain',
    );
    expect(messages[0].value).toMatchObject({
      sender: SENDER,
      leaseUuid: LEASE_UUID,
      serviceName: '',
      customDomain: 'app.example.com',
    });
  });

  it('builds MsgSetItemCustomDomain with --service-name', () => {
    const { messages } = buildBillingMessages(
      SENDER,
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com', '--service-name', 'web'],
    );

    expect(messages[0].value).toMatchObject({
      leaseUuid: LEASE_UUID,
      serviceName: 'web',
      customDomain: 'app.example.com',
    });
  });

  it('builds MsgSetItemCustomDomain with --clear (custom_domain becomes "")', () => {
    const { messages } = buildBillingMessages(
      SENDER,
      'set-item-custom-domain',
      [LEASE_UUID, '--clear'],
    );

    expect(messages[0].value).toMatchObject({
      leaseUuid: LEASE_UUID,
      customDomain: '',
    });
  });

  it('rejects when neither <custom-domain> nor --clear is provided', () => {
    expect(() =>
      buildBillingMessages(SENDER, 'set-item-custom-domain', [LEASE_UUID]),
    ).toThrow();
  });
});

describe('buildBillingMessages — update-params', () => {
  it('forwards --reserved-suffix flags into params.reservedDomainSuffixes', () => {
    const { messages } = buildBillingMessages(SENDER, 'update-params', [
      '10',
      '5',
      '3600',
      '2',
      '300',
      '--reserved-suffix',
      '.barney0.manifest0.net',
      '--reserved-suffix',
      '.example.test',
    ]);

    expect(messages[0].typeUrl).toBe(
      '/liftedinit.billing.v1.MsgUpdateParams',
    );
    expect(messages[0].value).toMatchObject({
      authority: SENDER,
      params: expect.objectContaining({
        reservedDomainSuffixes: [
          '.barney0.manifest0.net',
          '.example.test',
        ],
        allowedList: [],
      }),
    });
  });

  it('keeps trailing positional args as allowedList when --reserved-suffix is mixed in', () => {
    const { messages } = buildBillingMessages(SENDER, 'update-params', [
      '10',
      '5',
      '3600',
      '2',
      '300',
      TENANT,
      '--reserved-suffix',
      '.example.test',
    ]);

    expect(messages[0].value).toMatchObject({
      params: expect.objectContaining({
        allowedList: [TENANT],
        reservedDomainSuffixes: ['.example.test'],
      }),
    });
  });
});
