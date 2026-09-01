import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import {
  assertManifestFitsUpdateRequest,
  findNonIntegerJsonNumberLiteral,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_VALIDATION_MESSAGE_CHARACTERS,
  MAX_UPDATE_MANIFEST_BYTES,
  parseAndValidateManifestPayload,
} from './validateManifestPayload.js';

describe('parseAndValidateManifestPayload', () => {
  it.each([
    '{"image":"nginx","stop_grace_period":1e9}',
    '{"image":"nginx","stop_grace_period":1000000000.0}',
    '{"image":"nginx","health_check":{"test":["CMD","x"],"retries":3.0}}',
    '{"image":"nginx","ports":{"80/tcp":{"host_port":0.0}}}',
  ])('rejects Go-incompatible integer literal spelling in %s', (manifest) => {
    expect(() => parseAndValidateManifestPayload(manifest)).toThrowError(
      expect.objectContaining({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: expect.stringContaining('integer JSON literals'),
      }),
    );
  });

  it('ignores decimal/exponent text inside quoted JSON strings', () => {
    const manifest = '{"image":"repo/app:1.0e2","env":{"VALUE":"3.0"}}';
    expect(findNonIntegerJsonNumberLiteral(manifest)).toBeUndefined();
    expect(parseAndValidateManifestPayload(manifest).validation.valid).toBe(
      true,
    );
  });

  it('accepts integer tokens in all numeric manifest positions', () => {
    const manifest =
      '{"image":"nginx","ports":{"80/tcp":{"host_port":0}},"health_check":{"test":["NONE"],"retries":3},"stop_grace_period":1000000000}';
    expect(parseAndValidateManifestPayload(manifest).validation.valid).toBe(
      true,
    );
  });

  it("accounts exactly for update's base64 JSON envelope", () => {
    expect(MAX_UPDATE_MANIFEST_BYTES).toBe(786_420);
    const envelopeBytes = (rawBytes: number) =>
      new TextEncoder().encode(
        JSON.stringify({
          payload: 'A'.repeat(4 * Math.ceil(rawBytes / 3)),
        }),
      ).length;
    expect(envelopeBytes(MAX_UPDATE_MANIFEST_BYTES)).toBeLessThanOrEqual(
      MAX_MANIFEST_BYTES,
    );
    expect(envelopeBytes(MAX_UPDATE_MANIFEST_BYTES + 1)).toBeGreaterThan(
      MAX_MANIFEST_BYTES,
    );
    expect(() =>
      assertManifestFitsUpdateRequest(
        new Uint8Array(MAX_UPDATE_MANIFEST_BYTES),
      ),
    ).not.toThrow();
    expect(() =>
      assertManifestFitsUpdateRequest(
        new Uint8Array(MAX_UPDATE_MANIFEST_BYTES + 1),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: ManifestMCPErrorCode.INVALID_CONFIG,
        message: expect.stringContaining('base64 JSON encoding'),
      }),
    );
  });

  it('bounds first-party validation errors before they enter MCP output', () => {
    const manifest = JSON.stringify({
      services: Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [
          `service-${index}`,
          {
            image: '',
            command: 'not-an-array',
            [`unsupported-${index}-${'x'.repeat(120)}`]: true,
          },
        ]),
      ),
    });
    expect(new TextEncoder().encode(manifest).length).toBeLessThan(
      MAX_MANIFEST_BYTES,
    );

    let thrown: unknown;
    try {
      parseAndValidateManifestPayload(manifest);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestMCPError);
    const error = thrown as ManifestMCPError;
    expect(error.code).toBe(ManifestMCPErrorCode.INVALID_CONFIG);
    expect([...error.message].length).toBeLessThanOrEqual(
      MAX_MANIFEST_VALIDATION_MESSAGE_CHARACTERS,
    );
    const errors = error.details?.errors as string[];
    expect(errors.length).toBeLessThanOrEqual(16);
    expect(errors.every((message) => [...message].length <= 240)).toBe(true);
    expect(JSON.stringify(error.toJSON()).length).toBeLessThan(10_000);
  });
});
