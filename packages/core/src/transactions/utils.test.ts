import { describe, it, expect } from 'vitest';
import { toBech32 } from '@cosmjs/encoding';
import { parseAmount, parseBigInt, extractFlag, extractBooleanFlag, filterConsumedArgs, parseColonPair, parseLeaseItem, validateAddress, validateMemo, validateArgsLength, requireArgs, parseHexBytes, bytesToHex, parseVoteOption } from './utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

describe('parseAmount', () => {
  it('should parse valid amount strings', () => {
    expect(parseAmount('1000umfx')).toEqual({ amount: '1000', denom: 'umfx' });
    expect(parseAmount('1uatom')).toEqual({ amount: '1', denom: 'uatom' });
    expect(parseAmount('999999999token')).toEqual({ amount: '999999999', denom: 'token' });
  });

  it('should handle denominations with numbers', () => {
    expect(parseAmount('100ibc123')).toEqual({ amount: '100', denom: 'ibc123' });
  });

  it('should handle factory denoms with slashes', () => {
    expect(parseAmount('1000000factory/manifest1abc123/upwr')).toEqual({
      amount: '1000000',
      denom: 'factory/manifest1abc123/upwr',
    });
  });

  it('should handle IBC denoms with slashes', () => {
    expect(parseAmount('500ibc/ABC123DEF456')).toEqual({
      amount: '500',
      denom: 'ibc/ABC123DEF456',
    });
  });

  it('should handle denoms with underscores', () => {
    expect(parseAmount('100my_token')).toEqual({ amount: '100', denom: 'my_token' });
  });

  it('should throw ManifestMCPError for invalid format', () => {
    expect(() => parseAmount('')).toThrow(ManifestMCPError);
    expect(() => parseAmount('umfx')).toThrow(ManifestMCPError);
    expect(() => parseAmount('1000')).toThrow(ManifestMCPError);
    expect(() => parseAmount('abc123')).toThrow(ManifestMCPError);
    expect(() => parseAmount('1000 umfx')).toThrow(ManifestMCPError);
  });

  it('should have correct error code for invalid format', () => {
    try {
      parseAmount('invalid');
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.TX_FAILED);
    }
  });

  it('should provide helpful hint for empty string', () => {
    try {
      parseAmount('');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('Received empty string');
    }
  });

  it('should provide helpful hint for amount with space', () => {
    try {
      parseAmount('1000 umfx');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('Remove the space');
    }
  });

  it('should provide helpful hint for amount with comma', () => {
    try {
      parseAmount('1,000umfx');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('Do not use commas');
    }
  });

  it('should provide helpful hint for missing denomination', () => {
    try {
      parseAmount('1000');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('Missing denomination');
    }
  });

  it('should provide helpful hint for denom-first format', () => {
    try {
      parseAmount('umfx1000');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('must start with a number');
    }
  });

  it('should include details with received value and example', () => {
    try {
      parseAmount('bad');
    } catch (error) {
      const details = (error as ManifestMCPError).details;
      expect(details?.receivedValue).toBe('bad');
      expect(details?.example).toBe('1000000umfx');
    }
  });
});

describe('parseBigInt', () => {
  it('should parse valid integer strings', () => {
    expect(parseBigInt('0', 'test')).toBe(BigInt(0));
    expect(parseBigInt('123', 'test')).toBe(BigInt(123));
    expect(parseBigInt('9999999999999999999', 'test')).toBe(BigInt('9999999999999999999'));
  });

  it('should throw ManifestMCPError for invalid integers', () => {
    expect(() => parseBigInt('abc', 'field')).toThrow(ManifestMCPError);
    expect(() => parseBigInt('12.34', 'field')).toThrow(ManifestMCPError);
    expect(() => parseBigInt('1e10', 'field')).toThrow(ManifestMCPError);
  });

  it('should throw ManifestMCPError for empty string', () => {
    // Empty string should be rejected for security (prevents accidental 0 values)
    expect(() => parseBigInt('', 'field')).toThrow(ManifestMCPError);
    expect(() => parseBigInt('   ', 'field')).toThrow(ManifestMCPError);
  });

  it('should include field name in error message', () => {
    try {
      parseBigInt('invalid', 'proposal-id');
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect((error as ManifestMCPError).message).toContain('proposal-id');
    }
  });
});

describe('extractFlag', () => {
  it('should extract flag value when present', () => {
    const result = extractFlag(['--memo', 'hello'], '--memo', 'test');
    expect(result.value).toBe('hello');
    expect(result.consumedIndices).toEqual([0, 1]);
  });

  it('should return undefined when flag not present', () => {
    const result = extractFlag(['arg1', 'arg2'], '--memo', 'test');
    expect(result.value).toBeUndefined();
    expect(result.consumedIndices).toEqual([]);
  });

  it('should handle flag in middle of args', () => {
    const result = extractFlag(['arg1', '--memo', 'hello', 'arg2'], '--memo', 'test');
    expect(result.value).toBe('hello');
    expect(result.consumedIndices).toEqual([1, 2]);
  });

  it('should throw when flag has no value', () => {
    expect(() => extractFlag(['--memo'], '--memo', 'test')).toThrow(ManifestMCPError);
  });

  it('should throw when flag value looks like another flag', () => {
    expect(() => extractFlag(['--memo', '--other'], '--memo', 'test')).toThrow(ManifestMCPError);
  });

  it('should include context in error message', () => {
    try {
      extractFlag(['--memo'], '--memo', 'bank send');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('bank send');
      expect((error as ManifestMCPError).message).toContain('--memo');
    }
  });
});

describe('filterConsumedArgs', () => {
  it('should filter out consumed indices', () => {
    const result = filterConsumedArgs(['a', 'b', 'c', 'd'], [1, 2]);
    expect(result).toEqual(['a', 'd']);
  });

  it('should return original array when no indices consumed', () => {
    const result = filterConsumedArgs(['a', 'b', 'c'], []);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('should handle all indices consumed', () => {
    const result = filterConsumedArgs(['a', 'b'], [0, 1]);
    expect(result).toEqual([]);
  });

  it('should handle non-contiguous indices', () => {
    const result = filterConsumedArgs(['a', 'b', 'c', 'd', 'e'], [0, 2, 4]);
    expect(result).toEqual(['b', 'd']);
  });
});

describe('parseColonPair', () => {
  it('should parse valid colon-separated pairs', () => {
    expect(parseColonPair('address:amount', 'address', 'amount', 'test')).toEqual(['address', 'amount']);
    expect(parseColonPair('key:value', 'key', 'value', 'test')).toEqual(['key', 'value']);
  });

  it('should handle values with colons (takes first colon as separator)', () => {
    const result = parseColonPair('address:100:extra', 'address', 'amount', 'test');
    expect(result).toEqual(['address', '100:extra']);
  });

  it('should throw for missing colon', () => {
    expect(() => parseColonPair('nodelimiter', 'left', 'right', 'test')).toThrow(ManifestMCPError);
  });

  it('should throw for empty left side', () => {
    expect(() => parseColonPair(':value', 'left', 'right', 'test')).toThrow(ManifestMCPError);
  });

  it('should throw for empty right side', () => {
    expect(() => parseColonPair('key:', 'left', 'right', 'test')).toThrow(ManifestMCPError);
  });

  it('should include context and field names in error messages', () => {
    try {
      parseColonPair('invalid', 'address', 'amount', 'multi-send');
    } catch (error) {
      const message = (error as ManifestMCPError).message;
      expect(message).toContain('multi-send');
      expect(message).toContain('address');
      expect(message).toContain('amount');
    }
  });

  it('should provide specific error for missing left value', () => {
    try {
      parseColonPair(':value', 'address', 'amount', 'test');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('Missing address');
    }
  });

  it('should provide specific error for missing right value', () => {
    try {
      parseColonPair('key:', 'address', 'amount', 'test');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('Missing amount');
    }
  });
});

describe('parseLeaseItem', () => {
  it('should parse sku-uuid:quantity (no service name)', () => {
    const result = parseLeaseItem('sku-123:1');
    expect(result).toEqual({ skuUuid: 'sku-123', quantity: BigInt(1), serviceName: '' });
  });

  it('should parse sku-uuid:quantity:service-name', () => {
    const result = parseLeaseItem('sku-123:1:web');
    expect(result).toEqual({ skuUuid: 'sku-123', quantity: BigInt(1), serviceName: 'web' });
  });

  it('should accept valid DNS label service names', () => {
    expect(parseLeaseItem('sku:2:db').serviceName).toBe('db');
    expect(parseLeaseItem('sku:1:my-service-1').serviceName).toBe('my-service-1');
    expect(parseLeaseItem('sku:1:a').serviceName).toBe('a');
    expect(parseLeaseItem('sku:1:a1b2c3').serviceName).toBe('a1b2c3');
  });

  it('should reject invalid service names', () => {
    expect(() => parseLeaseItem('sku:1:-web')).toThrow(ManifestMCPError);
    expect(() => parseLeaseItem('sku:1:web-')).toThrow(ManifestMCPError);
    expect(() => parseLeaseItem('sku:1:Web')).toThrow(ManifestMCPError);
    expect(() => parseLeaseItem('sku:1:web_server')).toThrow(ManifestMCPError);
    expect(() => parseLeaseItem('sku:1:web.server')).toThrow(ManifestMCPError);
  });

  it('should reject empty service name (trailing colon)', () => {
    expect(() => parseLeaseItem('sku:1:')).toThrow(ManifestMCPError);
    expect(() => parseLeaseItem('sku:1:')).toThrow(/Empty service-name/);
  });

  it('should reject too many colons', () => {
    expect(() => parseLeaseItem('sku:1:web:extra')).toThrow(ManifestMCPError);
  });

  it('should reject missing colon', () => {
    expect(() => parseLeaseItem('nocolon')).toThrow(ManifestMCPError);
  });

  it('should reject empty sku-uuid', () => {
    expect(() => parseLeaseItem(':1')).toThrow(ManifestMCPError);
  });

  it('should reject empty quantity', () => {
    expect(() => parseLeaseItem('sku:')).toThrow(ManifestMCPError);
  });

  it('should reject non-integer quantity', () => {
    expect(() => parseLeaseItem('sku:abc')).toThrow(ManifestMCPError);
    expect(() => parseLeaseItem('sku:1.5:web')).toThrow(ManifestMCPError);
  });

  it('should handle UUID-style sku-uuids', () => {
    const result = parseLeaseItem('019beb87-09de-7000-beef-ae733e73ff23:1:web');
    expect(result.skuUuid).toBe('019beb87-09de-7000-beef-ae733e73ff23');
    expect(result.quantity).toBe(BigInt(1));
    expect(result.serviceName).toBe('web');
  });
});

describe('validateAddress', () => {
  // Generate valid bech32 addresses programmatically using @cosmjs/encoding
  // 20 bytes is the standard Cosmos address length
  const validManifestAddress = toBech32('manifest', new Uint8Array(20));
  const validCosmosAddress = toBech32('cosmos', new Uint8Array(20));

  it('should accept valid bech32 addresses', () => {
    expect(() => validateAddress(validManifestAddress, 'test')).not.toThrow();
    expect(() => validateAddress(validCosmosAddress, 'test')).not.toThrow();
  });

  it('should throw for empty address', () => {
    expect(() => validateAddress('', 'recipient')).toThrow(ManifestMCPError);
    expect(() => validateAddress('   ', 'recipient')).toThrow(ManifestMCPError);
  });

  it('should throw for invalid bech32 address', () => {
    expect(() => validateAddress('notanaddress', 'recipient')).toThrow(ManifestMCPError);
    expect(() => validateAddress('manifest1invalid', 'recipient')).toThrow(ManifestMCPError);
  });

  it('should use INVALID_ADDRESS error code', () => {
    try {
      validateAddress('invalid', 'recipient');
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.INVALID_ADDRESS);
    }
  });

  it('should include field name in error message', () => {
    try {
      validateAddress('invalid', 'validator address');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('validator address');
    }
  });

  it('should validate expected prefix when provided', () => {
    // Should pass when prefix matches
    expect(() => validateAddress(validManifestAddress, 'test', 'manifest')).not.toThrow();

    // Should fail when prefix doesn't match
    expect(() => validateAddress(validManifestAddress, 'test', 'cosmos')).toThrow(ManifestMCPError);
  });

  it('should include expected prefix in error message', () => {
    try {
      validateAddress(validManifestAddress, 'recipient', 'cosmos');
    } catch (error) {
      const message = (error as ManifestMCPError).message;
      expect(message).toContain('cosmos');
      expect(message).toContain('manifest');
    }
  });
});

describe('validateMemo', () => {
  it('should accept memo within limit', () => {
    expect(() => validateMemo('')).not.toThrow();
    expect(() => validateMemo('short memo')).not.toThrow();
    expect(() => validateMemo('a'.repeat(256))).not.toThrow();
  });

  it('should throw for memo exceeding 256 characters', () => {
    expect(() => validateMemo('a'.repeat(257))).toThrow(ManifestMCPError);
    expect(() => validateMemo('a'.repeat(500))).toThrow(ManifestMCPError);
  });

  it('should use TX_FAILED error code', () => {
    try {
      validateMemo('a'.repeat(300));
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.TX_FAILED);
    }
  });

  it('should include length info in error message', () => {
    try {
      validateMemo('a'.repeat(300));
    } catch (error) {
      const message = (error as ManifestMCPError).message;
      expect(message).toContain('300');
      expect(message).toContain('256');
    }
  });
});

describe('validateArgsLength', () => {
  it('should accept args within limit', () => {
    expect(() => validateArgsLength([], 'test')).not.toThrow();
    expect(() => validateArgsLength(['a', 'b', 'c'], 'test')).not.toThrow();
    expect(() => validateArgsLength(new Array(100).fill('arg'), 'test')).not.toThrow();
  });

  it('should throw for args exceeding 100 items', () => {
    expect(() => validateArgsLength(new Array(101).fill('arg'), 'test')).toThrow(ManifestMCPError);
    expect(() => validateArgsLength(new Array(200).fill('arg'), 'test')).toThrow(ManifestMCPError);
  });

  it('should use TX_FAILED error code', () => {
    try {
      validateArgsLength(new Array(150).fill('arg'), 'test');
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.TX_FAILED);
    }
  });

  it('should include context and count in error message', () => {
    try {
      validateArgsLength(new Array(150).fill('arg'), 'bank send');
    } catch (error) {
      const message = (error as ManifestMCPError).message;
      expect(message).toContain('bank send');
      expect(message).toContain('150');
      expect(message).toContain('100');
    }
  });
});

describe('requireArgs', () => {
  it('should pass when args meet minimum count', () => {
    expect(() => requireArgs(['a', 'b'], 2, ['arg1', 'arg2'], 'test')).not.toThrow();
    expect(() => requireArgs(['a', 'b', 'c'], 2, ['arg1', 'arg2'], 'test')).not.toThrow();
  });

  it('should pass when zero args required', () => {
    expect(() => requireArgs([], 0, [], 'test')).not.toThrow();
  });

  it('should throw when args below minimum count', () => {
    expect(() => requireArgs(['a'], 2, ['arg1', 'arg2'], 'test')).toThrow(ManifestMCPError);
    expect(() => requireArgs([], 1, ['arg1'], 'test')).toThrow(ManifestMCPError);
  });

  it('should use TX_FAILED error code by default', () => {
    try {
      requireArgs([], 1, ['arg1'], 'test');
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.TX_FAILED);
    }
  });

  it('should include context in error message', () => {
    try {
      requireArgs(['a'], 2, ['recipient', 'amount'], 'bank send');
    } catch (error) {
      const message = (error as ManifestMCPError).message;
      expect(message).toContain('bank send');
      expect(message).toContain('recipient');
      expect(message).toContain('amount');
    }
  });

  it('should include received args in error message', () => {
    try {
      requireArgs(['value1'], 2, ['arg1', 'arg2'], 'test');
    } catch (error) {
      const message = (error as ManifestMCPError).message;
      expect(message).toContain('"value1"');
      expect(message).toContain('Received 1');
    }
  });

  it('should show "none" when no args received', () => {
    try {
      requireArgs([], 1, ['arg1'], 'test');
    } catch (error) {
      const message = (error as ManifestMCPError).message;
      expect(message).toContain('none');
    }
  });

  it('should include details with expected and received args', () => {
    try {
      requireArgs(['a'], 2, ['arg1', 'arg2'], 'test');
    } catch (error) {
      const details = (error as ManifestMCPError).details;
      expect(details?.expectedArgs).toEqual(['arg1', 'arg2']);
      expect(details?.receivedArgs).toEqual(['a']);
      expect(details?.receivedCount).toBe(1);
      expect(details?.requiredCount).toBe(2);
    }
  });

  it('should accept custom error code', () => {
    try {
      requireArgs([], 1, ['arg1'], 'test', ManifestMCPErrorCode.QUERY_FAILED);
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    }
  });
});

describe('parseHexBytes', () => {
  it('should parse valid hex strings', () => {
    expect(parseHexBytes('deadbeef', 'test', 100)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(parseHexBytes('00', 'test', 100)).toEqual(new Uint8Array([0x00]));
    expect(parseHexBytes('ff', 'test', 100)).toEqual(new Uint8Array([0xff]));
    expect(parseHexBytes('0123456789abcdef', 'test', 100)).toEqual(
      new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef])
    );
  });

  it('should be case-insensitive', () => {
    expect(parseHexBytes('DEADBEEF', 'test', 100)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(parseHexBytes('DeAdBeEf', 'test', 100)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('should throw for empty string', () => {
    expect(() => parseHexBytes('', 'field', 100)).toThrow(ManifestMCPError);
    expect(() => parseHexBytes('   ', 'field', 100)).toThrow(ManifestMCPError);
  });

  it('should throw for odd-length hex strings', () => {
    expect(() => parseHexBytes('abc', 'field', 100)).toThrow(ManifestMCPError);
    expect(() => parseHexBytes('1', 'field', 100)).toThrow(ManifestMCPError);
    expect(() => parseHexBytes('12345', 'field', 100)).toThrow(ManifestMCPError);
  });

  it('should throw for exceeding max bytes', () => {
    expect(() => parseHexBytes('deadbeef', 'field', 2)).toThrow(ManifestMCPError);
    expect(() => parseHexBytes('0102030405', 'field', 2)).toThrow(ManifestMCPError);
  });

  it('should accept exactly max bytes', () => {
    expect(parseHexBytes('deadbeef', 'test', 4)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('should throw for invalid hex characters', () => {
    expect(() => parseHexBytes('ghij', 'field', 100)).toThrow(ManifestMCPError);
    expect(() => parseHexBytes('12gg', 'field', 100)).toThrow(ManifestMCPError);
    expect(() => parseHexBytes('xy00', 'field', 100)).toThrow(ManifestMCPError);
  });

  it('should use TX_FAILED error code by default', () => {
    try {
      parseHexBytes('', 'field', 100);
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.TX_FAILED);
    }
  });

  it('should accept custom error code', () => {
    try {
      parseHexBytes('', 'field', 100, ManifestMCPErrorCode.QUERY_FAILED);
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    }
  });

  it('should include field name in error message', () => {
    try {
      parseHexBytes('', 'my-custom-field', 100);
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('my-custom-field');
    }
  });
});

describe('bytesToHex', () => {
  it('should convert bytes to hex string', () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
    expect(bytesToHex(new Uint8Array([0x00]))).toBe('00');
    expect(bytesToHex(new Uint8Array([0xff]))).toBe('ff');
    expect(bytesToHex(new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]))).toBe('0123456789abcdef');
  });

  it('should handle empty array', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('');
  });

  it('should round-trip with parseHexBytes', () => {
    const original = 'deadbeefcafe1234';
    const bytes = parseHexBytes(original, 'test', 100);
    expect(bytesToHex(bytes)).toBe(original);
  });
});

describe('extractBooleanFlag', () => {
  it('should return true and filtered args when flag is present', () => {
    const result = extractBooleanFlag(['arg1', '--active-only', 'arg2'], '--active-only');
    expect(result.value).toBe(true);
    expect(result.remainingArgs).toEqual(['arg1', 'arg2']);
  });

  it('should return false and original args when flag is absent', () => {
    const args = ['arg1', 'arg2'];
    const result = extractBooleanFlag(args, '--active-only');
    expect(result.value).toBe(false);
    expect(result.remainingArgs).toEqual(['arg1', 'arg2']);
  });

  it('should handle flag at the beginning', () => {
    const result = extractBooleanFlag(['--flag', 'a', 'b'], '--flag');
    expect(result.value).toBe(true);
    expect(result.remainingArgs).toEqual(['a', 'b']);
  });

  it('should handle flag at the end', () => {
    const result = extractBooleanFlag(['a', 'b', '--flag'], '--flag');
    expect(result.value).toBe(true);
    expect(result.remainingArgs).toEqual(['a', 'b']);
  });

  it('should handle flag as only argument', () => {
    const result = extractBooleanFlag(['--flag'], '--flag');
    expect(result.value).toBe(true);
    expect(result.remainingArgs).toEqual([]);
  });

  it('should handle empty args', () => {
    const result = extractBooleanFlag([], '--flag');
    expect(result.value).toBe(false);
    expect(result.remainingArgs).toEqual([]);
  });

  it('should only remove the first occurrence', () => {
    const result = extractBooleanFlag(['--flag', 'a', '--flag'], '--flag');
    expect(result.value).toBe(true);
    // indexOf finds the first occurrence at index 0, only that is removed
    expect(result.remainingArgs).toEqual(['a', '--flag']);
  });
});

describe('parseVoteOption', () => {
  // Mock VoteOption enum matching the cosmos.gov.v1 / cosmos.group.v1 shape
  const mockVoteOption = {
    VOTE_OPTION_YES: 1,
    VOTE_OPTION_ABSTAIN: 2,
    VOTE_OPTION_NO: 3,
    VOTE_OPTION_NO_WITH_VETO: 4,
  };

  it('should parse string vote options (case-insensitive)', () => {
    expect(parseVoteOption('yes', mockVoteOption)).toBe(1);
    expect(parseVoteOption('YES', mockVoteOption)).toBe(1);
    expect(parseVoteOption('Yes', mockVoteOption)).toBe(1);
    expect(parseVoteOption('no', mockVoteOption)).toBe(3);
    expect(parseVoteOption('abstain', mockVoteOption)).toBe(2);
    expect(parseVoteOption('no_with_veto', mockVoteOption)).toBe(4);
    expect(parseVoteOption('nowithveto', mockVoteOption)).toBe(4);
  });

  it('should parse numeric vote options', () => {
    expect(parseVoteOption('1', mockVoteOption)).toBe(1);
    expect(parseVoteOption('2', mockVoteOption)).toBe(2);
    expect(parseVoteOption('3', mockVoteOption)).toBe(3);
    expect(parseVoteOption('4', mockVoteOption)).toBe(4);
  });

  it('should use enum values from the provided object', () => {
    // Verify it actually uses the enum values, not hardcoded numbers
    const customEnum = {
      VOTE_OPTION_YES: 10,
      VOTE_OPTION_ABSTAIN: 20,
      VOTE_OPTION_NO: 30,
      VOTE_OPTION_NO_WITH_VETO: 40,
    };
    expect(parseVoteOption('yes', customEnum)).toBe(10);
    expect(parseVoteOption('no', customEnum)).toBe(30);
  });

  it('should throw ManifestMCPError for invalid option', () => {
    expect(() => parseVoteOption('invalid', mockVoteOption)).toThrow(ManifestMCPError);
    expect(() => parseVoteOption('maybe', mockVoteOption)).toThrow(ManifestMCPError);
    expect(() => parseVoteOption('0', mockVoteOption)).toThrow(ManifestMCPError);
    expect(() => parseVoteOption('5', mockVoteOption)).toThrow(ManifestMCPError);
  });

  it('should use TX_FAILED error code', () => {
    try {
      parseVoteOption('invalid', mockVoteOption);
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.TX_FAILED);
    }
  });

  it('should include the invalid option in error message', () => {
    try {
      parseVoteOption('badvalue', mockVoteOption);
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('badvalue');
    }
  });
});
