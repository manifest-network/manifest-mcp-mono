import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  type ManifestFormat,
  type ManifestValidationResult,
  validateManifest,
} from '../manifest.js';

// Match Fred's DefaultMaxRequestBodySize (1 << 20) for raw deploy payloads.
// Update adds a tighter derived check for its base64 JSON envelope below.
export const MAX_MANIFEST_BYTES = 1 << 20;
export const MAX_MANIFEST_VALIDATION_MESSAGE_CHARACTERS = 2_048;
const EMPTY_UPDATE_ENVELOPE_BYTES = new TextEncoder().encode(
  JSON.stringify({ payload: '' }),
).length;
// Fred applies the same 1 MiB inbound cap to update's JSON body. The manifest
// is a Go []byte and therefore expands to base64 inside {"payload":"..."}.
export const MAX_UPDATE_MANIFEST_BYTES =
  3 * Math.floor((MAX_MANIFEST_BYTES - EMPTY_UPDATE_ENVELOPE_BYTES) / 4);
const MAX_JSON_NUMBER_LITERAL_DIAGNOSTIC_CHARACTERS = 80;

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

/**
 * Return the first decimal/exponent JSON number outside a quoted string.
 * Fred decodes every numeric manifest field into int/int64, and Go's
 * encoding/json rejects those literal spellings even when their parsed
 * JavaScript value is mathematically integral.
 */
export function findNonIntegerJsonNumberLiteral(
  source: string,
): string | undefined {
  const numberToken = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== '-' && (char < '0' || char > '9')) continue;
    numberToken.lastIndex = index;
    const literal = numberToken.exec(source)?.[0];
    if (literal === undefined) continue;
    if (literal.includes('.') || /[eE]/.test(literal)) return literal;
    index += literal.length - 1;
  }
  return undefined;
}

export function displayJsonNumberLiteral(literal: string): string {
  if (literal.length <= MAX_JSON_NUMBER_LITERAL_DIAGNOSTIC_CHARACTERS)
    return literal;
  return `${literal.slice(0, 39)}…${literal.slice(-40)}`;
}

export interface ValidatedManifestPayload {
  readonly bytes: Uint8Array;
  readonly parsed: Record<string, unknown>;
  readonly format: ManifestFormat;
  readonly validation: ManifestValidationResult;
}

export function assertManifestFitsUpdateRequest(bytes: Uint8Array): void {
  if (bytes.length <= MAX_UPDATE_MANIFEST_BYTES) return;
  throw new ManifestMCPError(
    ManifestMCPErrorCode.INVALID_CONFIG,
    `Update manifest is ${bytes.length} bytes; base64 JSON encoding would exceed Fred's default ${MAX_MANIFEST_BYTES}-byte request limit. The maximum raw update manifest is ${MAX_UPDATE_MANIFEST_BYTES} bytes.`,
    {
      size: bytes.length,
      max: MAX_UPDATE_MANIFEST_BYTES,
      requestMax: MAX_MANIFEST_BYTES,
    },
  );
}

/**
 * Apply the shared deploy/update payload boundary before either path mutates
 * chain or provider state. Structural/semantic validation runs on the parsed
 * value, while integer-token validation inspects the exact UTF-8 text that is
 * sent over the wire. Callers that merge partial manifests must pass the final
 * merge.
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

  const nonIntegerLiteral = findNonIntegerJsonNumberLiteral(manifest);
  if (nonIntegerLiteral !== undefined) {
    const displayed = displayJsonNumberLiteral(nonIntegerLiteral);
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Manifest numeric values must use integer JSON literals; Fred rejects decimal or exponent form ${JSON.stringify(displayed)}.`,
      { literal: displayed },
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
