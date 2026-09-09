import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

export const MAX_UINT32 = 4_294_967_295;
export const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_INT64 = (1n << 63n) - 1n;

/** google.protobuf.Duration's semantic bound, narrower than its int64 wire field.
 * https://protobuf.dev/reference/protobuf/google.protobuf/#duration
 */
export const MAX_DURATION_SECONDS = 315_576_000_000n;

function parseDecimalInRange(
  value: string,
  fieldName: string,
  min: bigint,
  max: bigint,
  errorCode: ManifestMCPErrorCode,
): bigint {
  const pattern = min < 0n ? /^-?\d+$/ : /^\d+$/;
  if (typeof value !== 'string' || !value.match(pattern)) {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${fieldName}: expected a ${min < 0n ? '' : 'non-negative '}decimal integer string.`,
    );
  }
  const parsed = BigInt(value);
  if (parsed < min || parsed > max) {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${fieldName}: must be between ${min} and ${max}.`,
    );
  }
  return parsed;
}

/** Reject values the protobuf encoder would silently reduce modulo 2^64. */
export function parseUint64(
  value: string,
  fieldName: string,
  errorCode = ManifestMCPErrorCode.TX_FAILED,
): bigint {
  return parseDecimalInRange(value, fieldName, 0n, MAX_UINT64, errorCode);
}

/** Signed wire fields retain their negative range, unlike uint64 identifiers. */
export function parseInt64(
  value: string,
  fieldName: string,
  errorCode = ManifestMCPErrorCode.TX_FAILED,
): bigint {
  return parseDecimalInRange(
    value,
    fieldName,
    -MAX_INT64 - 1n,
    MAX_INT64,
    errorCode,
  );
}

/** The durations exposed by our transaction builders are non-negative. */
export function parseDurationSeconds(value: string, fieldName: string): bigint {
  return parseDecimalInRange(
    value,
    fieldName,
    0n,
    MAX_DURATION_SECONDS,
    ManifestMCPErrorCode.TX_FAILED,
  );
}
