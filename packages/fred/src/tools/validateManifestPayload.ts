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
const MAX_INT64_LITERAL = '9223372036854775807';
const MIN_INT64_MAGNITUDE_LITERAL = '9223372036854775808';

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

export interface InvalidJsonNumberLiteral {
  readonly literal: string;
  readonly reason: 'non_integer_spelling' | 'outside_int64';
}

function integerLiteralFitsInt64(literal: string): boolean {
  const negative = literal.startsWith('-');
  const digits = negative ? literal.slice(1) : literal;
  const limit = negative ? MIN_INT64_MAGNITUDE_LITERAL : MAX_INT64_LITERAL;
  return (
    digits.length < limit.length ||
    (digits.length === limit.length && digits <= limit)
  );
}

/**
 * Return the first JSON number token Fred cannot decode into an int/int64.
 * The scan skips quoted strings and uses lexical range comparison so even a
 * payload-sized integer cannot force a giant BigInt allocation.
 */
export function findInvalidJsonNumberLiteral(
  source: string,
): InvalidJsonNumberLiteral | undefined {
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
    if (literal.includes('.') || /[eE]/.test(literal)) {
      return { literal, reason: 'non_integer_spelling' };
    }
    if (!integerLiteralFitsInt64(literal)) {
      return { literal, reason: 'outside_int64' };
    }
    index += literal.length - 1;
  }
  return undefined;
}

/** Return the first decoded object key that occurs twice in the same object. */
export function findDuplicateJsonObjectKey(source: string): string | undefined {
  const containers: Array<
    { readonly kind: 'array' } | { readonly kind: 'object'; keys: Set<string> }
  > = [];

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '{') {
      containers.push({ kind: 'object', keys: new Set() });
      continue;
    }
    if (char === '[') {
      containers.push({ kind: 'array' });
      continue;
    }
    if (char === '}' || char === ']') {
      containers.pop();
      continue;
    }
    if (char !== '"') continue;

    const start = index;
    let escaped = false;
    for (index++; index < source.length; index++) {
      const stringChar = source[index];
      if (escaped) {
        escaped = false;
      } else if (stringChar === '\\') {
        escaped = true;
      } else if (stringChar === '"') {
        break;
      }
    }

    const container = containers.at(-1);
    if (container?.kind !== 'object') continue;
    let next = index + 1;
    while (/\s/.test(source[next] ?? '')) next++;
    if (source[next] !== ':') continue;

    // parseAndValidateManifestPayload calls this only after JSON.parse has
    // accepted the complete document, so this slice is guaranteed to be a
    // valid JSON string literal.
    const key = JSON.parse(source.slice(start, index + 1)) as string;
    if (container.keys.has(key)) return key;
    container.keys.add(key);
  }
  return undefined;
}

export function displayJsonNumberLiteral(literal: string): string {
  if (literal.length <= MAX_JSON_NUMBER_LITERAL_DIAGNOSTIC_CHARACTERS)
    return literal;
  return `${literal.slice(0, 39)}…${literal.slice(-40)}`;
}

export function displayJsonObjectKey(key: string): string {
  const escaped = JSON.stringify(key);
  const characters = Array.from(escaped);
  if (characters.length <= MAX_JSON_NUMBER_LITERAL_DIAGNOSTIC_CHARACTERS)
    return escaped;
  return `${characters.slice(0, 39).join('')}…${characters.slice(-40).join('')}`;
}

export function jsonNumberLiteralErrorMessage(
  issue: InvalidJsonNumberLiteral,
  subject = 'Manifest',
): string {
  const displayed = displayJsonNumberLiteral(issue.literal);
  return issue.reason === 'non_integer_spelling'
    ? `${subject} numeric values must use integer JSON literals; Fred rejects decimal or exponent form ${JSON.stringify(displayed)}.`
    : `${subject} integer literal ${JSON.stringify(displayed)} is outside Fred's signed 64-bit range.`;
}

export function duplicateJsonObjectKeyErrorMessage(
  key: string,
  subject = 'Manifest',
): string {
  return `${subject} contains duplicate object key ${displayJsonObjectKey(key)}; Fred rejects duplicates.`;
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

  const duplicateKey = findDuplicateJsonObjectKey(manifest);
  if (duplicateKey !== undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      duplicateJsonObjectKeyErrorMessage(duplicateKey),
      { key: displayJsonObjectKey(duplicateKey) },
    );
  }

  const invalidNumber = findInvalidJsonNumberLiteral(manifest);
  if (invalidNumber !== undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      jsonNumberLiteralErrorMessage(invalidNumber),
      {
        literal: displayJsonNumberLiteral(invalidNumber.literal),
        reason: invalidNumber.reason,
      },
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
