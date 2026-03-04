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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Require a non-empty string field that is a valid UUID.
 */
export function requireUuid(
  input: Record<string, unknown>,
  field: string,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED,
): string {
  const val = requireString(input, field, errorCode);
  if (!UUID_PATTERN.test(val)) {
    const display = val.length > 50 ? val.slice(0, 50) + '...' : val;
    throw new ManifestMCPError(
      errorCode,
      `${field} must be a valid UUID (e.g., "550e8400-e29b-41d4-a716-446655440000"), got "${display}"`,
    );
  }
  return val;
}

/**
 * Extract an optional boolean field from tool input.
 * Rejects non-boolean truthy values (e.g. string "true") to prevent unchecked casts.
 */
export function optionalBoolean(
  input: Record<string, unknown>,
  field: string,
  defaultValue = false,
): boolean {
  const val = input[field];
  if (val === undefined || val === null) return defaultValue;
  if (typeof val === 'boolean') return val;
  throw new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    `${field} must be a boolean, got ${typeof val}`,
  );
}
