import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  type ManifestFormat,
  type ManifestValidationResult,
  validateManifest,
} from '../manifest.js';

export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_MANIFEST_VALIDATION_MESSAGE_CHARACTERS = 2_048;

function validationErrorMessage(errors: readonly string[]): string {
  const prefix = 'Invalid manifest: ';
  const joined = errors.join('; ');
  const available = MAX_MANIFEST_VALIDATION_MESSAGE_CHARACTERS - prefix.length;
  const characters = Array.from(joined);
  const summary =
    characters.length <= available
      ? joined
      : `${characters.slice(0, available - 1).join('')}…`;
  return `${prefix}${summary}`;
}

export interface ValidatedManifestPayload {
  readonly bytes: Uint8Array;
  readonly parsed: Record<string, unknown>;
  readonly format: ManifestFormat;
  readonly validation: ManifestValidationResult;
}

/**
 * Apply the shared deploy/update payload boundary before either path mutates
 * chain or provider state. Validation runs on the exact UTF-8 bytes sent over
 * the wire; callers that merge partial manifests must pass the final merge.
 */
export function parseAndValidateManifestPayload(
  manifest: string,
): ValidatedManifestPayload {
  const bytes = new TextEncoder().encode(manifest);
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Manifest is ${bytes.length} bytes; the maximum is ${MAX_MANIFEST_BYTES}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch (error) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const topKeys = Object.keys(parsed as Record<string, unknown>);
    if (topKeys.includes('__proto__') || topKeys.includes('constructor')) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'Manifest must not contain a top-level "__proto__" or "constructor" key.',
      );
    }
  }

  const validation = validateManifest(parsed);
  if (!validation.valid || validation.format === null) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      validationErrorMessage(validation.errors),
      { errors: validation.errors },
    );
  }

  return {
    bytes,
    parsed: parsed as Record<string, unknown>,
    format: validation.format,
    validation,
  };
}
