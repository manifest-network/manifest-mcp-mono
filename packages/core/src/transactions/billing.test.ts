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

  it('rejects an empty positional <custom-domain> without --clear (would silently clear on chain)', () => {
    try {
      buildBillingMessages(SENDER, 'set-item-custom-domain', [LEASE_UUID, '']);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestMCPError);
      expect((e as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      expect((e as ManifestMCPError).message).toContain('cannot be empty');
      expect((e as ManifestMCPError).message).toContain('--clear');
    }
  });

  it('rejects whitespace-only <custom-domain> without --clear', () => {
    expect(() =>
      buildBillingMessages(SENDER, 'set-item-custom-domain', [
        LEASE_UUID,
        '   ',
      ]),
    ).toThrow(ManifestMCPError);
  });

  it('rejects --clear combined with a positional <custom-domain> instead of silently clearing', () => {
    try {
      buildBillingMessages(SENDER, 'set-item-custom-domain', [
        LEASE_UUID,
        'app.example.com',
        '--clear',
      ]);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestMCPError);
      expect((e as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      expect((e as ManifestMCPError).message).toContain('--clear');
      expect((e as ManifestMCPError).message).toContain('app.example.com');
    }
  });

  it('rejects extra positional args without --clear', () => {
    try {
      buildBillingMessages(SENDER, 'set-item-custom-domain', [
        LEASE_UUID,
        'app.example.com',
        'extra-positional',
      ]);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestMCPError);
      expect((e as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      expect((e as ManifestMCPError).message).toContain('extra-positional');
    }
  });

  it('trims surrounding whitespace on the positional <custom-domain> before assigning to MsgSetItemCustomDomain', () => {
    // Pinned by c9cf3e1: direct `cosmos_tx billing set-item-custom-domain`
    // callers ship the same canonical FQDN as MCP-routed callers.
    const { messages } = buildBillingMessages(
      SENDER,
      'set-item-custom-domain',
      [LEASE_UUID, '  app.example.com  '],
    );
    expect(messages[0].value).toMatchObject({
      leaseUuid: LEASE_UUID,
      customDomain: 'app.example.com',
    });
  });

  it('rejects --service-name that is not a valid RFC 1123 DNS label', () => {
    try {
      buildBillingMessages(SENDER, 'set-item-custom-domain', [
        LEASE_UUID,
        'app.example.com',
        '--service-name',
        'NotALabel',
      ]);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestMCPError);
      expect((e as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      expect((e as ManifestMCPError).message).toContain('NotALabel');
      expect((e as ManifestMCPError).message).toContain('RFC 1123');
    }
  });

  it('accepts an empty --service-name implicit value (omitted flag) for legacy 1-item leases', () => {
    const { messages } = buildBillingMessages(
      SENDER,
      'set-item-custom-domain',
      [LEASE_UUID, 'app.example.com'],
    );
    expect(messages[0].value).toMatchObject({ serviceName: '' });
  });
});

describe('buildBillingMessages — update-params', () => {
  const NUMERIC_ARGS = ['10', '5', '3600', '2', '300'];

  it('forwards --reserved-suffix flags into params.reservedDomainSuffixes', () => {
    const { messages } = buildBillingMessages(SENDER, 'update-params', [
      ...NUMERIC_ARGS,
      '--reserved-suffix',
      '.barney0.manifest0.net',
      '--reserved-suffix',
      '.example.test',
    ]);

    expect(messages[0].typeUrl).toBe('/liftedinit.billing.v1.MsgUpdateParams');
    expect(messages[0].value).toMatchObject({
      authority: SENDER,
      params: expect.objectContaining({
        reservedDomainSuffixes: ['.barney0.manifest0.net', '.example.test'],
        allowedList: [],
      }),
    });
  });

  it('keeps trailing positional args as allowedList when --reserved-suffix is mixed in', () => {
    const { messages } = buildBillingMessages(SENDER, 'update-params', [
      ...NUMERIC_ARGS,
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

  it('preserves on-chain reservedDomainSuffixes when neither --reserved-suffix nor --clear-reserved-suffixes is supplied', () => {
    const currentBillingParams = {
      maxLeasesPerTenant: 1n,
      maxItemsPerLease: 1n,
      minLeaseDuration: 1n,
      maxPendingLeasesPerTenant: 1n,
      pendingTimeout: 60n,
      allowedList: [TENANT],
      reservedDomainSuffixes: [
        '.barney0.manifest0.net',
        '.alice0.manifest0.net',
      ],
    };

    const { messages } = buildBillingMessages(
      SENDER,
      'update-params',
      NUMERIC_ARGS,
      { currentBillingParams },
    );

    expect(messages[0].value).toMatchObject({
      params: expect.objectContaining({
        reservedDomainSuffixes: [
          '.barney0.manifest0.net',
          '.alice0.manifest0.net',
        ],
        allowedList: [TENANT],
      }),
    });
  });

  it('explicitly clears reservedDomainSuffixes when --clear-reserved-suffixes is set', () => {
    const currentBillingParams = {
      maxLeasesPerTenant: 1n,
      maxItemsPerLease: 1n,
      minLeaseDuration: 1n,
      maxPendingLeasesPerTenant: 1n,
      pendingTimeout: 60n,
      allowedList: [],
      reservedDomainSuffixes: ['.x.test'],
    };

    const { messages } = buildBillingMessages(
      SENDER,
      'update-params',
      [...NUMERIC_ARGS, '--clear-reserved-suffixes'],
      { currentBillingParams },
    );

    expect(messages[0].value).toMatchObject({
      params: expect.objectContaining({ reservedDomainSuffixes: [] }),
    });
  });

  it('explicitly clears allowedList when --clear-allowed-list is set', () => {
    const currentBillingParams = {
      maxLeasesPerTenant: 1n,
      maxItemsPerLease: 1n,
      minLeaseDuration: 1n,
      maxPendingLeasesPerTenant: 1n,
      pendingTimeout: 60n,
      allowedList: [TENANT],
      reservedDomainSuffixes: [],
    };

    const { messages } = buildBillingMessages(
      SENDER,
      'update-params',
      [...NUMERIC_ARGS, '--clear-allowed-list'],
      { currentBillingParams },
    );

    expect(messages[0].value).toMatchObject({
      params: expect.objectContaining({ allowedList: [] }),
    });
  });

  it('rejects --reserved-suffix combined with --clear-reserved-suffixes (mutually exclusive)', () => {
    expect(() =>
      buildBillingMessages(SENDER, 'update-params', [
        ...NUMERIC_ARGS,
        '--reserved-suffix',
        '.x.test',
        '--clear-reserved-suffixes',
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects positional <allowed-address> combined with --clear-allowed-list (mutually exclusive)', () => {
    expect(() =>
      buildBillingMessages(SENDER, 'update-params', [
        ...NUMERIC_ARGS,
        TENANT,
        '--clear-allowed-list',
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it('without context falls back to empty list fields when nothing explicit is provided', () => {
    // Sync builder used by cosmosEstimateFee paths cannot fetch chain state;
    // it produces an explicit-only message with empty list fields.
    const { messages } = buildBillingMessages(
      SENDER,
      'update-params',
      NUMERIC_ARGS,
    );

    expect(messages[0].value).toMatchObject({
      params: expect.objectContaining({
        reservedDomainSuffixes: [],
        allowedList: [],
      }),
    });
  });

  it('asymmetric: setting --reserved-suffix preserves on-chain allowedList when no positional addresses are passed', () => {
    const currentBillingParams = {
      maxLeasesPerTenant: 9n,
      maxItemsPerLease: 9n,
      minLeaseDuration: 9n,
      maxPendingLeasesPerTenant: 9n,
      pendingTimeout: 60n,
      allowedList: [TENANT],
      reservedDomainSuffixes: ['.preserved.example'],
    };

    const { messages } = buildBillingMessages(
      SENDER,
      'update-params',
      [...NUMERIC_ARGS, '--reserved-suffix', '.new.test'],
      { currentBillingParams },
    );

    expect(messages[0].value).toMatchObject({
      params: expect.objectContaining({
        reservedDomainSuffixes: ['.new.test'],
        allowedList: [TENANT],
      }),
    });
  });

  it('asymmetric: setting positional <allowed-address> preserves on-chain reservedDomainSuffixes when --reserved-suffix is not supplied', () => {
    const currentBillingParams = {
      maxLeasesPerTenant: 9n,
      maxItemsPerLease: 9n,
      minLeaseDuration: 9n,
      maxPendingLeasesPerTenant: 9n,
      pendingTimeout: 60n,
      allowedList: ['manifest1existing'],
      reservedDomainSuffixes: ['.preserved.example'],
    };

    const { messages } = buildBillingMessages(
      SENDER,
      'update-params',
      [...NUMERIC_ARGS, TENANT],
      { currentBillingParams },
    );

    expect(messages[0].value).toMatchObject({
      params: expect.objectContaining({
        allowedList: [TENANT],
        reservedDomainSuffixes: ['.preserved.example'],
      }),
    });
  });
});
