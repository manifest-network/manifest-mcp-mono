import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/**
 * Anchored UUID-shape regex (8-4-4-4-12, version-byte lenient). Single source of
 * truth, re-exported from `validation.ts`.
 *
 * This lives in its own module — NOT alongside `validateAddress` in
 * `validation.ts` — so importing `assertUuid` does not drag `@cosmjs/encoding`
 * (`fromBech32`) into a bundle. `@cosmjs/encoding` is not marked side-effect-free,
 * so esbuild retains its import from any module that references it, which pushed
 * ~1.5 kB of bech32 code into the tree-shakable `/reads` SDK subpath once the
 * branded reads began validating uuids (ENG-536).
 */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Assert a BARE string is a valid UUID. Single source of truth (reused by requireUuid + brand constructors). */
export function assertUuid(
  value: string,
  label: string,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.QUERY_FAILED,
): void {
  if (!UUID_RE.test(value)) {
    const display = value.length > 50 ? `${value.slice(0, 50)}...` : value;
    throw new ManifestMCPError(
      errorCode,
      `${label} must be a valid UUID (e.g., "550e8400-e29b-41d4-a716-446655440000"), got "${display}"`,
    );
  }
}
