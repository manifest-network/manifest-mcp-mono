import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { parseBigIntWithCode, requireArgs as requireArgsBase, extractFlag, filterConsumedArgs, validateAddress, extractBooleanFlag } from '../transactions/utils.js';

export { validateAddress, extractBooleanFlag };
export type { ExtractedBooleanFlag } from '../transactions/utils.js';

/** Default page size limit for paginated queries to prevent resource exhaustion */
export const DEFAULT_PAGE_LIMIT = BigInt(100);

/** Maximum page size limit to prevent DoS */
export const MAX_PAGE_LIMIT = BigInt(1000);

/**
 * Cosmos SDK pagination configuration
 */
export interface PaginationConfig {
  readonly key: Uint8Array;
  readonly offset: bigint;
  readonly limit: bigint;
  readonly countTotal: boolean;
  readonly reverse: boolean;
}

/**
 * Create pagination configuration with optional custom limit.
 * Validates that limit is within acceptable bounds.
 *
 * @param limit - Optional custom limit (defaults to DEFAULT_PAGE_LIMIT)
 * @returns Cosmos SDK pagination object
 */
export function createPagination(limit?: bigint): PaginationConfig {
  let effectiveLimit = limit ?? DEFAULT_PAGE_LIMIT;

  // Clamp to valid range
  if (effectiveLimit < BigInt(1)) {
    effectiveLimit = BigInt(1);
  } else if (effectiveLimit > MAX_PAGE_LIMIT) {
    effectiveLimit = MAX_PAGE_LIMIT;
  }

  return {
    key: new Uint8Array(),
    offset: BigInt(0),
    limit: effectiveLimit,
    countTotal: false,
    reverse: false,
  };
}

/**
 * Default pagination configuration for queries (for backwards compatibility)
 * @deprecated Use createPagination() instead for configurable limits
 */
export const defaultPagination = createPagination();

/**
 * Extract --limit flag from args and return pagination config with remaining args.
 * Use this helper for paginated queries.
 *
 * @param args - The arguments array
 * @param context - Context for error messages
 * @returns Object with pagination config and filtered args
 */
export function extractPaginationArgs(
  args: string[],
  context: string
): { pagination: PaginationConfig; remainingArgs: string[] } {
  const { value: limitStr, consumedIndices } = extractFlag(args, '--limit', context);
  const remainingArgs = filterConsumedArgs(args, consumedIndices);

  let pagination: PaginationConfig;
  if (limitStr) {
    const limit = parseBigInt(limitStr, 'limit');
    if (limit < BigInt(1) || limit > MAX_PAGE_LIMIT) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        `Invalid limit: ${limit}. Must be between 1 and ${MAX_PAGE_LIMIT}.`
      );
    }
    pagination = createPagination(limit);
  } else {
    pagination = createPagination();
  }

  return { pagination, remainingArgs };
}

/**
 * Safely parse a string to BigInt with proper error handling (for queries)
 */
export function parseBigInt(value: string, fieldName: string): bigint {
  return parseBigIntWithCode(value, fieldName, ManifestMCPErrorCode.QUERY_FAILED);
}

/**
 * Safely parse a string to integer with proper error handling.
 * Named parseInteger to avoid shadowing global parseInt.
 */
export function parseInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.QUERY_FAILED,
      `Invalid ${fieldName}: "${value}". Expected a valid integer.`
    );
  }
  return parsed;
}

/**
 * Validate that required arguments are present (for queries).
 * Uses QUERY_FAILED error code by default.
 */
export function requireArgs(
  args: string[],
  minCount: number,
  expectedNames: string[],
  context: string
): void {
  requireArgsBase(args, minCount, expectedNames, context, ManifestMCPErrorCode.QUERY_FAILED);
}
