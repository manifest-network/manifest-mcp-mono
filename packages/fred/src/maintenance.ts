import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';

/** Fred accepts one lowercase, hyphenated UUIDv4 per logical maintenance command. */
export const MAINTENANCE_IDEMPOTENCY_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function resolveMaintenanceIdempotencyKey(key?: string): string {
  if (key === undefined) return globalThis.crypto.randomUUID();
  if (typeof key !== 'string' || !MAINTENANCE_IDEMPOTENCY_KEY_RE.test(key)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ARGUMENT,
      'idempotencyKey must be a canonical lowercase UUIDv4.',
    );
  }
  return key;
}
