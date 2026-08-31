import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import {
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_VALIDATION_MESSAGE_CHARACTERS,
  parseAndValidateManifestPayload,
} from './validateManifestPayload.js';

describe('parseAndValidateManifestPayload', () => {
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
