import { fromBech32 } from '@cosmjs/encoding';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/**
 * Require a non-empty string field from tool input.
 */
export function requireString(
  input: Record<string, unknown>,
  field: string,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED,
): string {
  const val = input[field];
  if (typeof val !== 'string' || val.length === 0) {
    throw new ManifestMCPError(
      errorCode,
      `${field} is required and must be a non-empty string`,
    );
  }
  return val;
}

/**
 * Require a string field that matches one of the allowed enum values.
 */
export function requireStringEnum<T extends string>(
  input: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const val = requireString(input, field);
  if (!allowed.includes(val as T)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `${field} must be one of: ${allowed.join(', ')}`,
    );
  }
  return val as T;
}

/**
 * Parse raw args input into string array.
 * Throws if a non-array, non-nullish value is provided (e.g., a bare string).
 */
export function parseArgs(
  rawArgs: unknown,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED,
): string[] {
  if (rawArgs === undefined || rawArgs === null) {
    return [];
  }
  if (Array.isArray(rawArgs)) {
    return rawArgs.map(String);
  }
  if (typeof rawArgs === 'string') {
    throw new ManifestMCPError(
      errorCode,
      `args must be an array of strings, not a single string. Use ["${rawArgs}"] instead of "${rawArgs}".`,
    );
  }
  throw new ManifestMCPError(
    errorCode,
    `args must be an array of strings, got ${typeof rawArgs}`,
  );
}

/** RFC 1123 DNS label pattern: 1-63 lowercase alphanumeric or hyphens, no leading/trailing hyphen */
export const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** RFC-4122 UUID (any version), case-insensitive. */
// UUID_RE + assertUuid live in a lean, `@cosmjs/encoding`-free module so branded
// reads can validate a uuid without dragging bech32 into their bundle (ENG-536).
// Imported for local use by requireUuid below AND re-exported to keep this file
// the single import surface for validation.
import { assertUuid, UUID_RE } from './internals/uuid.js';

export { assertUuid, UUID_RE };

/**
 * Require a non-empty string field that is a valid UUID.
 */
export function requireUuid(
  input: Record<string, unknown>,
  field: string,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED,
): string {
  const val = requireString(input, field, errorCode);
  assertUuid(val, field, errorCode);
  return val;
}

/** Validate a bech32 address (optionally pinning the prefix). Throws ManifestMCPError. */
export function validateAddress(
  address: string,
  fieldName: string,
  expectedPrefix?: string,
): void {
  if (!address || address.trim() === '') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      `${fieldName} is required`,
    );
  }
  try {
    const { prefix } = fromBech32(address);
    if (expectedPrefix && prefix !== expectedPrefix) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_ADDRESS,
        `Invalid ${fieldName}: "${address}". Expected prefix "${expectedPrefix}", got "${prefix}"`,
      );
    }
  } catch (error) {
    if (error instanceof ManifestMCPError) throw error;
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      `Invalid ${fieldName}: "${address}". Not a valid bech32 address.`,
    );
  }
}

/**
 * Canonical client-side FQDN validator (consolidated from agent-core FQDN_RE):
 * 1-253 chars, >=2 dot-separated RFC-1123 labels (each 1-63), top-level label LETTER-led
 * so IPv4 literals are NOT valid FQDNs (RFC 1123 §2.1). Case-insensitive class — callers lowercase (RFC 4343).
 */
export const FQDN_RE =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** A URL scheme prefix (rejected for a bare FQDN). */
export const SCHEME_PREFIX_RE = /^https?:\/\//i;

/** Cosmos denom grammar: letter-led, then alphanumerics + / _ - (umfx, ibc/..., factory/...). */
export const DENOM_RE = /^[a-zA-Z][a-zA-Z0-9/_-]*$/;

/**
 * Extract an optional boolean field from tool input.
 * Rejects non-boolean truthy values (e.g. string "true") to prevent unchecked casts.
 */
export function optionalBoolean(
  input: Record<string, unknown>,
  field: string,
  defaultValue = false,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED,
): boolean {
  const val = input[field];
  if (val === undefined || val === null) return defaultValue;
  if (typeof val === 'boolean') return val;
  throw new ManifestMCPError(
    errorCode,
    `${field} must be a boolean, got ${typeof val}`,
  );
}
