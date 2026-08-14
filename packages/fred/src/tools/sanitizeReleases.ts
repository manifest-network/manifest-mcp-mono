import type { FredLeaseRelease } from '@manifest-network/manifest-mcp-core';
import { sanitizeFailureFields } from '../failure-reason.js';

/**
 * How many releases reach model context. Release history has NO pagination on either
 * side — `getLeaseReleases` sends no query params, and Fred's handler returns its whole
 * store (its only bound is an 8 MiB `MaxReleasesBytes`; `RemoveOlderThan` prunes by AGE,
 * never by count). `restart_app` appends a release too, so the count grows on restarts
 * as well as updates.
 *
 * Stripping the manifest alone does not close that: a stripped element is ~150 bytes, so
 * 8 MiB admits tens of thousands of them. 20 x ~150 B x the two copies
 * `structuredResponse` emits is ~6 KB — the same order as `MAX_LOG_CHARS` (ENG-669).
 */
export const MAX_RELEASES = 20;

/** Padded standard base64, which is how Go marshals a `[]byte`. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decoded byte length of a base64 string, WITHOUT decoding it — decoding a multi-MB
 * blob just to measure it would reintroduce the allocation this exists to avoid, and
 * `atob`/`Buffer` would cost the module its browser-safety.
 */
function base64Bytes(b64: string): number | undefined {
  if (b64 === '' || b64.length % 4 !== 0 || b64.match(BASE64_RE) === null) {
    return undefined;
  }
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

/**
 * Project one release for AI-facing output.
 *
 * Fred sends the FULL base64 manifest on every release — `Manifest []byte` with no
 * `omitempty`, so it is always present — and `app_releases` forwarded it wholesale into
 * `structuredContent`, which `structuredResponse` then duplicates into the text content.
 * A model cannot usefully decode base64, and `build_manifest_preview` is the better
 * provenance for the decoded form, so the blob is dropped and only its SIZE reported
 * (ENG-669).
 *
 * `manifest_bytes` is validate-or-drop, mirroring how `sanitizeRetentionFields` treats
 * `retained_until`: provider JSON is type-asserted and never validated, so `manifest`
 * can be `null` (a nil `[]byte`), a number, or malformed base64. Emitting a wrong size
 * is worse than emitting none.
 */
export function sanitizeReleaseFields(
  r: FredLeaseRelease,
): Record<string, unknown> {
  // Strip the raw failure keys BEFORE re-adding the sanitized projection: spreading
  // the sanitizer over the raw object leaks any key it drops (ENG-638).
  const {
    manifest: rawManifest,
    reason: _reason,
    message: _message,
    error: _error,
    ...rest
  } = r;
  const bytes =
    typeof rawManifest === 'string' ? base64Bytes(rawManifest) : undefined;
  return {
    ...rest,
    ...(bytes !== undefined ? { manifest_bytes: bytes } : {}),
    ...sanitizeFailureFields(r),
  };
}

/**
 * Project a release list under the AI-context budget.
 *
 * Takes the TAIL: Fred's `ReleaseStore.Append` + `Latest = releases[len-1]` make
 * oldest-first its contract, so the newest entries are the ones worth keeping.
 * Deliberately does NOT re-sort by `version` — that field is type-asserted off the wire
 * and can be a non-number.
 */
export function projectReleases(releases: readonly FredLeaseRelease[]): {
  releases: Record<string, unknown>[];
  release_count: number;
  truncated: boolean;
} {
  const kept =
    releases.length > MAX_RELEASES ? releases.slice(-MAX_RELEASES) : releases;
  return {
    releases: kept.map(sanitizeReleaseFields),
    // The provider's true total, so the model knows older entries exist — and, since
    // neither side paginates, that there is no way to page to them.
    release_count: releases.length,
    truncated: releases.length > MAX_RELEASES,
  };
}
