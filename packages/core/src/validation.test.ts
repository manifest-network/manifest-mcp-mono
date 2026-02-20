import { describe, it, expect } from 'vitest';
import { requireString, requireStringEnum, parseArgs, optionalBoolean } from './validation.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

describe('requireString', () => {
  it('should return a valid string', () => {
    expect(requireString({ name: 'hello' }, 'name')).toBe('hello');
  });

  it('should throw for empty string', () => {
    expect(() => requireString({ name: '' }, 'name')).toThrow(ManifestMCPError);
    expect(() => requireString({ name: '' }, 'name')).toThrow(/name is required/);
  });

  it('should throw for missing field', () => {
    expect(() => requireString({}, 'name')).toThrow(ManifestMCPError);
  });

  it('should throw for non-string value', () => {
    expect(() => requireString({ name: 42 }, 'name')).toThrow(ManifestMCPError);
    expect(() => requireString({ name: true }, 'name')).toThrow(/must be a non-empty string/);
  });

  it('should use custom error code', () => {
    try {
      requireString({}, 'module', ManifestMCPErrorCode.TX_FAILED);
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.TX_FAILED);
    }
  });

  it('should default to QUERY_FAILED error code', () => {
    try {
      requireString({}, 'module');
    } catch (err) {
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.QUERY_FAILED);
    }
  });
});

describe('requireStringEnum', () => {
  it('should return a valid enum value', () => {
    expect(requireStringEnum({ type: 'query' }, 'type', ['query', 'tx'] as const)).toBe('query');
    expect(requireStringEnum({ type: 'tx' }, 'type', ['query', 'tx'] as const)).toBe('tx');
  });

  it('should throw for invalid enum value', () => {
    expect(() => requireStringEnum({ type: 'bad' }, 'type', ['query', 'tx'] as const)).toThrow(ManifestMCPError);
    expect(() => requireStringEnum({ type: 'bad' }, 'type', ['query', 'tx'] as const)).toThrow(/must be one of: query, tx/);
  });

  it('should throw for missing field', () => {
    expect(() => requireStringEnum({}, 'type', ['query', 'tx'] as const)).toThrow(ManifestMCPError);
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
    expect(() => optionalBoolean({ flag: 'true' }, 'flag')).toThrow(ManifestMCPError);
    expect(() => optionalBoolean({ flag: 'true' }, 'flag')).toThrow(/must be a boolean, got string/);
  });

  it('should throw for number value', () => {
    expect(() => optionalBoolean({ flag: 1 }, 'flag')).toThrow(ManifestMCPError);
    expect(() => optionalBoolean({ flag: 1 }, 'flag')).toThrow(/must be a boolean, got number/);
  });

  it('should use TX_FAILED error code', () => {
    try {
      optionalBoolean({ flag: 'yes' }, 'flag');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(ManifestMCPErrorCode.TX_FAILED);
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

  it('should return empty array for non-array input', () => {
    expect(parseArgs(undefined)).toEqual([]);
    expect(parseArgs(null)).toEqual([]);
    expect(parseArgs('not-an-array')).toEqual([]);
    expect(parseArgs(42)).toEqual([]);
  });

  it('should return empty array for empty array', () => {
    expect(parseArgs([])).toEqual([]);
  });
});
