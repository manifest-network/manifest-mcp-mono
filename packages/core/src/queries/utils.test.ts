import { describe, it, expect } from 'vitest';
import {
  parseBigInt,
  parseInteger,
  createPagination,
  extractPaginationArgs,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from './utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

describe('parseBigInt', () => {
  it('should parse valid integer strings', () => {
    expect(parseBigInt('0', 'height')).toBe(BigInt(0));
    expect(parseBigInt('123', 'height')).toBe(BigInt(123));
    expect(parseBigInt('9999999999999999999', 'height')).toBe(BigInt('9999999999999999999'));
  });

  it('should throw ManifestMCPError for invalid integers', () => {
    expect(() => parseBigInt('abc', 'height')).toThrow(ManifestMCPError);
    expect(() => parseBigInt('12.34', 'height')).toThrow(ManifestMCPError);
  });

  it('should throw ManifestMCPError for empty string', () => {
    // Empty string should be rejected for security (prevents accidental 0 values)
    expect(() => parseBigInt('', 'height')).toThrow(ManifestMCPError);
    expect(() => parseBigInt('   ', 'height')).toThrow(ManifestMCPError);
  });

  it('should have correct error code', () => {
    try {
      parseBigInt('invalid', 'height');
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    }
  });

  it('should include field name in error message', () => {
    try {
      parseBigInt('invalid', 'block-height');
    } catch (error) {
      expect((error as ManifestMCPError).message).toContain('block-height');
    }
  });
});

describe('parseInteger', () => {
  it('should parse valid integer strings', () => {
    expect(parseInteger('0', 'status')).toBe(0);
    expect(parseInteger('123', 'status')).toBe(123);
    expect(parseInteger('-5', 'status')).toBe(-5);
  });

  it('should throw ManifestMCPError for invalid integers', () => {
    expect(() => parseInteger('', 'status')).toThrow(ManifestMCPError);
    expect(() => parseInteger('abc', 'status')).toThrow(ManifestMCPError);
  });

  it('should have correct error code', () => {
    try {
      parseInteger('invalid', 'status');
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestMCPError);
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    }
  });
});

describe('createPagination', () => {
  it('should use default limit when none provided', () => {
    const pagination = createPagination();
    expect(pagination.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(pagination.offset).toBe(BigInt(0));
    expect(pagination.countTotal).toBe(false);
    expect(pagination.reverse).toBe(false);
    expect(pagination.key).toEqual(new Uint8Array());
  });

  it('should use provided limit', () => {
    const pagination = createPagination(BigInt(50));
    expect(pagination.limit).toBe(BigInt(50));
  });

  it('should clamp limit to minimum of 1', () => {
    const pagination = createPagination(BigInt(0));
    expect(pagination.limit).toBe(BigInt(1));

    const paginationNegative = createPagination(BigInt(-10));
    expect(paginationNegative.limit).toBe(BigInt(1));
  });

  it('should clamp limit to maximum', () => {
    const pagination = createPagination(BigInt(9999));
    expect(pagination.limit).toBe(MAX_PAGE_LIMIT);
  });
});

describe('extractPaginationArgs', () => {
  it('should return default pagination when no --limit flag', () => {
    const { pagination, remainingArgs } = extractPaginationArgs(['arg1', 'arg2'], 'test');
    expect(pagination.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(remainingArgs).toEqual(['arg1', 'arg2']);
  });

  it('should extract --limit flag and value', () => {
    const { pagination, remainingArgs } = extractPaginationArgs(
      ['arg1', '--limit', '50', 'arg2'],
      'test'
    );
    expect(pagination.limit).toBe(BigInt(50));
    expect(remainingArgs).toEqual(['arg1', 'arg2']);
  });

  it('should handle --limit at end of args', () => {
    const { pagination, remainingArgs } = extractPaginationArgs(
      ['arg1', '--limit', '25'],
      'test'
    );
    expect(pagination.limit).toBe(BigInt(25));
    expect(remainingArgs).toEqual(['arg1']);
  });

  it('should handle --limit at start of args', () => {
    const { pagination, remainingArgs } = extractPaginationArgs(
      ['--limit', '75', 'arg1'],
      'test'
    );
    expect(pagination.limit).toBe(BigInt(75));
    expect(remainingArgs).toEqual(['arg1']);
  });

  it('should throw for invalid limit value', () => {
    expect(() =>
      extractPaginationArgs(['--limit', 'abc'], 'test')
    ).toThrow(ManifestMCPError);
  });

  it('should throw for limit below minimum', () => {
    expect(() =>
      extractPaginationArgs(['--limit', '0'], 'test')
    ).toThrow(ManifestMCPError);
  });

  it('should throw for limit above maximum', () => {
    expect(() =>
      extractPaginationArgs(['--limit', '9999'], 'test')
    ).toThrow(ManifestMCPError);
  });

  it('should handle empty args array', () => {
    const { pagination, remainingArgs } = extractPaginationArgs([], 'test');
    expect(pagination.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(remainingArgs).toEqual([]);
  });
});
