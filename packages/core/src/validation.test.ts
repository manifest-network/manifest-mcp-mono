import { describe, expect, it } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import {
  optionalBoolean,
  parseArgs,
  requireString,
  requireStringEnum,
  requireUuid,
} from './validation.js';

describe('requireString', () => {
  it('should return a valid string', () => {
    expect(requireString({ name: 'hello' }, 'name')).toBe('hello');
  });

  it('should throw for empty string', () => {
    expect(() => requireString({ name: '' }, 'name')).toThrow(ManifestMCPError);
    expect(() => requireString({ name: '' }, 'name')).toThrow(
      /name is required/,
    );
  });

  it('should throw for missing field', () => {
    expect(() => requireString({}, 'name')).toThrow(ManifestMCPError);
  });

  it('should throw for non-string value', () => {
    expect(() => requireString({ name: 42 }, 'name')).toThrow(ManifestMCPError);
    expect(() => requireString({ name: true }, 'name')).toThrow(
      /must be a non-empty string/,
    );
  });

  it('should use custom error code', () => {
    try {
      requireString({}, 'module', ManifestMCPErrorCode.TX_FAILED);
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.TX_FAILED,
      );
    }
  });

  it('should default to QUERY_FAILED error code', () => {
    try {
      requireString({}, 'module');
    } catch (err) {
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.QUERY_FAILED,
      );
    }
  });
});

describe('requireStringEnum', () => {
  it('should return a valid enum value', () => {
    expect(
      requireStringEnum({ type: 'query' }, 'type', ['query', 'tx'] as const),
    ).toBe('query');
    expect(
      requireStringEnum({ type: 'tx' }, 'type', ['query', 'tx'] as const),
    ).toBe('tx');
  });

  it('should throw for invalid enum value', () => {
    expect(() =>
      requireStringEnum({ type: 'bad' }, 'type', ['query', 'tx'] as const),
    ).toThrow(ManifestMCPError);
    expect(() =>
      requireStringEnum({ type: 'bad' }, 'type', ['query', 'tx'] as const),
    ).toThrow(/must be one of: query, tx/);
  });

  it('should throw for missing field', () => {
    expect(() =>
      requireStringEnum({}, 'type', ['query', 'tx'] as const),
    ).toThrow(ManifestMCPError);
  });
});

describe('requireUuid', () => {
  it('should return a valid UUID', () => {
    expect(
      requireUuid({ id: '550e8400-e29b-41d4-a716-446655440000' }, 'id'),
    ).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should accept uppercase hex digits', () => {
    expect(
      requireUuid({ id: '550E8400-E29B-41D4-A716-446655440000' }, 'id'),
    ).toBe('550E8400-E29B-41D4-A716-446655440000');
  });

  it('should throw for non-UUID string', () => {
    expect(() => requireUuid({ id: 'not-a-uuid' }, 'id')).toThrow(
      ManifestMCPError,
    );
    expect(() => requireUuid({ id: 'not-a-uuid' }, 'id')).toThrow(
      /must be a valid UUID/,
    );
  });

  it('should throw for missing field', () => {
    expect(() => requireUuid({}, 'id')).toThrow(ManifestMCPError);
  });

  it('should throw for empty string', () => {
    expect(() => requireUuid({ id: '' }, 'id')).toThrow(ManifestMCPError);
  });

  it('should use custom error code', () => {
    try {
      requireUuid({ id: 'bad' }, 'id', ManifestMCPErrorCode.TX_FAILED);
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.TX_FAILED,
      );
    }
  });
});

describe('optionalBoolean', () => {
  it('should return true when value is true', () => {
    expect(optionalBoolean({ flag: true }, 'flag')).toBe(true);
  });

  it('should return false when value is false', () => {
    expect(optionalBoolean({ flag: false }, 'flag')).toBe(false);
  });

  it('should return default when value is undefined', () => {
    expect(optionalBoolean({}, 'flag')).toBe(false);
    expect(optionalBoolean({}, 'flag', true)).toBe(true);
  });

  it('should return default when value is null', () => {
    expect(optionalBoolean({ flag: null }, 'flag')).toBe(false);
    expect(optionalBoolean({ flag: null }, 'flag', true)).toBe(true);
  });

  it('should throw for string "true"', () => {
    expect(() => optionalBoolean({ flag: 'true' }, 'flag')).toThrow(
      ManifestMCPError,
    );
    expect(() => optionalBoolean({ flag: 'true' }, 'flag')).toThrow(
      /must be a boolean, got string/,
    );
  });

  it('should throw for number value', () => {
    expect(() => optionalBoolean({ flag: 1 }, 'flag')).toThrow(
      ManifestMCPError,
    );
    expect(() => optionalBoolean({ flag: 1 }, 'flag')).toThrow(
      /must be a boolean, got number/,
    );
  });

  it('should default to QUERY_FAILED error code', () => {
    try {
      optionalBoolean({ flag: 'yes' }, 'flag');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.QUERY_FAILED,
      );
    }
  });

  it('should use custom error code', () => {
    try {
      optionalBoolean(
        { flag: 'yes' },
        'flag',
        false,
        ManifestMCPErrorCode.TX_FAILED,
      );
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.TX_FAILED,
      );
    }
  });
});

describe('parseArgs', () => {
  it('should convert array of strings', () => {
    expect(parseArgs(['hello', 'world'])).toEqual(['hello', 'world']);
  });

  it('should stringify non-string elements', () => {
    expect(parseArgs([1, true, 'ok'])).toEqual(['1', 'true', 'ok']);
  });

  it('should return empty array for undefined/null', () => {
    expect(parseArgs(undefined)).toEqual([]);
    expect(parseArgs(null)).toEqual([]);
  });

  it('should throw for string input with helpful message', () => {
    expect(() => parseArgs('not-an-array')).toThrow(ManifestMCPError);
    expect(() => parseArgs('not-an-array')).toThrow(
      'args must be an array of strings, not a single string',
    );
  });

  it('should throw for other non-array types', () => {
    expect(() => parseArgs(42)).toThrow(ManifestMCPError);
    expect(() => parseArgs(42)).toThrow(
      'args must be an array of strings, got number',
    );
  });

  it('should return empty array for empty array', () => {
    expect(parseArgs([])).toEqual([]);
  });
});
