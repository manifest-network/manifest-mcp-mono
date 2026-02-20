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
 */
export function parseArgs(rawArgs: unknown): string[] {
  if (Array.isArray(rawArgs)) {
    return rawArgs.map(String);
  }
  return [];
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
