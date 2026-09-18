import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';

/** Fred accepts one lowercase, hyphenated UUIDv4 per logical maintenance command. */
export const MAINTENANCE_IDEMPOTENCY_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Create a cryptographically random command key to persist before a restart/update. */
export function createMaintenanceIdempotencyKey(): string {
  try {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    // getRandomValues is available in browsers where randomUUID is absent,
    // including contexts where randomUUID's secure-context restriction applies.
    if (typeof crypto?.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    // Missing or unavailable platform crypto is a configuration error before I/O.
  }
  throw new ManifestMCPError(
    ManifestMCPErrorCode.INVALID_CONFIG,
    'Secure randomness is unavailable. Supply an idempotencyKey created with a cryptographically secure UUIDv4 generator.',
  );
}

export function resolveMaintenanceIdempotencyKey(key?: string): string {
  if (key === undefined) return createMaintenanceIdempotencyKey();
  if (typeof key !== 'string' || !MAINTENANCE_IDEMPOTENCY_KEY_RE.test(key)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ARGUMENT,
      'idempotencyKey must be a canonical lowercase UUIDv4.',
    );
  }
  return key;
}
