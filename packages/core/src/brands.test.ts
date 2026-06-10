import { toBech32 } from '@cosmjs/encoding';
import { describe, expect, it } from 'vitest';
import {
  parseAddress,
  parseChainId,
  parseDenom,
  parseFqdn,
  parseLeaseUuid,
  parseProviderUuid,
  parseSkuUuid,
  parseTierName,
} from './brands.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { assertUuid } from './validation.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const ADDR = toBech32('manifest', new Uint8Array(20));

describe('uuid brands', () => {
  it('accept a valid UUID and return it unchanged', () => {
    expect(parseLeaseUuid(UUID)).toBe(UUID);
    expect(parseProviderUuid(UUID)).toBe(UUID);
    expect(parseSkuUuid(UUID)).toBe(UUID);
  });
  it('reject a non-UUID with INVALID_ARGUMENT and the field label', () => {
    try {
      parseLeaseUuid('nope');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_ARGUMENT,
      );
      expect((err as ManifestMCPError).message).toContain('leaseUuid');
    }
  });
  it('a malformed UUID yields the SAME code via parseLeaseUuid as via assertUuid(INVALID_ARGUMENT)', () => {
    const a = (() => {
      try {
        parseLeaseUuid('bad');
        return null;
      } catch (e) {
        return (e as ManifestMCPError).code;
      }
    })();
    const b = (() => {
      try {
        assertUuid('bad', 'leaseUuid', ManifestMCPErrorCode.INVALID_ARGUMENT);
        return null;
      } catch (e) {
        return (e as ManifestMCPError).code;
      }
    })();
    expect(a).toBe(b);
  });
});

describe('parseAddress', () => {
  it('accepts a valid bech32 address (prefix unpinned by default)', () => {
    expect(parseAddress(ADDR)).toBe(ADDR);
  });
  it('enforces the prefix when given (rejects a manifest addr as cosmos)', () => {
    expect(() => parseAddress(ADDR, 'cosmos')).toThrow(ManifestMCPError);
  });
  it('rejects a non-bech32 string with INVALID_ADDRESS', () => {
    try {
      parseAddress('not-an-address');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_ADDRESS,
      );
    }
  });
});

describe('parseFqdn', () => {
  it.each([
    'app.example.com',
    'a.io',
    'sub.domain.co.uk',
    'xn--80akhbyknj4f.com',
  ])('accepts %s', (fqdn) => {
    expect(parseFqdn(fqdn)).toBe(fqdn);
  });
  it('NORMALIZES case (RFC 4343) instead of rejecting', () => {
    expect(parseFqdn('APP.Example.COM')).toBe('app.example.com');
  });
  it.each([
    ['nodot'],
    [''],
    ['192.168.1.1'],
    ['https://app.io'],
    ['app.example.com.'],
    [`${'a'.repeat(64)}.com`],
    ['-bad.com'],
  ])('rejects %s', (bad) => {
    expect(() => parseFqdn(bad)).toThrow(ManifestMCPError);
  });
});

describe('trim + denom brands', () => {
  it('parseTierName/parseChainId accept non-empty, reject whitespace-only', () => {
    expect(parseTierName('docker-small')).toBe('docker-small');
    expect(parseChainId('manifest-1')).toBe('manifest-1');
    expect(() => parseTierName('   ')).toThrow(ManifestMCPError);
  });
  it('parseDenom enforces the denom grammar', () => {
    expect(parseDenom('umfx')).toBe('umfx');
    expect(parseDenom('ibc/ABC')).toBe('ibc/ABC');
    expect(() => parseDenom('1bad')).toThrow(ManifestMCPError);
    expect(() => parseDenom('')).toThrow(ManifestMCPError);
  });
});
