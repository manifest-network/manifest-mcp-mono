import { describe, expect, it } from 'vitest';
import { parseBooleanEnv } from './env-utils.js';
import { ManifestMCPError } from './types.js';

const ENV = 'MANIFEST_FRED_FETCH_GUARDED';

describe('parseBooleanEnv', () => {
  describe('truthy tokens', () => {
    const truthy = [
      '1',
      'true',
      'TRUE',
      'True',
      'yes',
      'Yes',
      'YES',
      'on',
      'ON',
    ];
    for (const v of truthy) {
      it(`'${v}' → true`, () => {
        expect(parseBooleanEnv(v, false, ENV)).toBe(true);
      });
    }
    it('strips surrounding whitespace', () => {
      expect(parseBooleanEnv('  true  ', false, ENV)).toBe(true);
    });
  });

  describe('falsy tokens', () => {
    const falsy = ['0', 'false', 'FALSE', 'False', 'no', 'No', 'off', 'OFF'];
    for (const v of falsy) {
      it(`'${v}' → false`, () => {
        expect(parseBooleanEnv(v, true, ENV)).toBe(false);
      });
    }
  });

  describe('default fallback', () => {
    it('undefined → defaultValue (true)', () => {
      expect(parseBooleanEnv(undefined, true, ENV)).toBe(true);
    });
    it('undefined → defaultValue (false)', () => {
      expect(parseBooleanEnv(undefined, false, ENV)).toBe(false);
    });
    it("empty string '' → defaultValue", () => {
      expect(parseBooleanEnv('', true, ENV)).toBe(true);
      expect(parseBooleanEnv('', false, ENV)).toBe(false);
    });
    it('whitespace-only → defaultValue', () => {
      expect(parseBooleanEnv('   ', true, ENV)).toBe(true);
      expect(parseBooleanEnv('\t\n', false, ENV)).toBe(false);
    });
  });

  describe('unrecognized values throw INVALID_CONFIG with env name in the message', () => {
    for (const v of ['maybe', 'ture', '2', 'enabled', 'disabled', 'y']) {
      it(`'${v}' → throws`, () => {
        let err: unknown;
        try {
          parseBooleanEnv(v, true, ENV);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(ManifestMCPError);
        expect((err as ManifestMCPError).code).toBe('INVALID_CONFIG');
        expect((err as ManifestMCPError).message).toContain(ENV);
        expect((err as ManifestMCPError).message).toContain(v);
      });
    }
  });
});
