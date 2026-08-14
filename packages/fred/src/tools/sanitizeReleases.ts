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
 * Per-string-value ceiling on a forwarded release field.
 *
 * Capping only `manifest` would leave the bound trivially bypassable: every other field
 * (`image`, `status`, or any key Fred grows) is forwarded verbatim, so a provider could
 * put 8 MiB in `image` and reach model context anyway — doubled, since
 * `structuredResponse` emits the projection twice.
 *
 * Values are capped rather than keys dropped, deliberately: `releases[]` is a
 * `looseObject` precisely so unmodelled Fred keys pass through and stay observable, and
 * the e2e wire-golden reads `Object.keys(release)` to detect provider drift. Projecting
 * to a known field list would bound the size but blind that detector.
 */
export const MAX_RELEASE_FIELD_CHARS = 512;

/** Total serialized budget for the projected list — the backstop under the per-field cap. */
export const MAX_RELEASES_CHARS = 16_000;

/** Cap a forwarded value. Non-strings (numbers, booleans, null) are already small. */
function capValue(v: unknown): unknown {
  if (typeof v !== 'string' || v.length <= MAX_RELEASE_FIELD_CHARS) return v;
  return `${Array.from(v).slice(0, MAX_RELEASE_FIELD_CHARS).join('')}…`;
}

/**
 * Project one release for AI-facing output.
 *
 * Fred sends the FULL base64 manifest on every release — `Manifest []byte` with no
 * `omitempty`, so it is always present — and `app_releases` forwarded it wholesale into
 * `structuredContent`, which `structuredResponse` then duplicates into the text content.
 * A model cannot usefully decode base64, so the blob is dropped and only its SIZE
 * reported. No MCP tool returns a historical manifest body; the raw bytes remain on the
 * library path (`getLeaseReleases`). (ENG-669)
 *
 * `manifest_bytes` is validate-or-drop, mirroring how `sanitizeRetentionFields` treats
 * `retained_until`: provider JSON is type-asserted and never validated, so `manifest`
 * can be `null` (a nil `[]byte`), a number, or malformed base64. Emitting a wrong size
 * is worse than emitting none.
 */
export function sanitizeReleaseFields(
  r: FredLeaseRelease,
): Record<string, unknown> {
  // Strip every key we re-derive BEFORE re-adding it: a spread cannot overwrite a key
  // its source chose to OMIT, so leaving the raw one forwards the unsanitized value
  // (ENG-638). That covers the failure keys `sanitizeFailureFields` owns — including
  // `last_error`, which it also drops when malformed — and a provider-supplied
  // `manifest_bytes`, which would otherwise survive whenever `manifest` is invalid and
  // could fail the declared `z.number()` output schema, killing the whole tool call.
  const {
    manifest: rawManifest,
    manifest_bytes: _manifestBytesRaw,
    reason: _reason,
    message: _message,
    last_error: _lastError,
    error: _error,
    ...rest
  } = r as FredLeaseRelease & {
    manifest_bytes?: unknown;
    last_error?: unknown;
  };
  const bytes =
    typeof rawManifest === 'string' ? base64Bytes(rawManifest) : undefined;
  const capped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) capped[k] = capValue(v);
  return {
    ...capped,
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
  let truncated = releases.length > MAX_RELEASES;
  const projected = (truncated ? releases.slice(-MAX_RELEASES) : releases).map(
    sanitizeReleaseFields,
  );

  // Backstop under the per-field cap: bound the SERIALIZED size too, since a provider
  // controls how many keys each element carries, not just how long each value is. Drop
  // from the front (oldest) so the newest survive. One element is always kept — an
  // empty list would be a worse answer than an over-budget one — so a single
  // pathological release is bounded by (its key count x MAX_RELEASE_FIELD_CHARS).
  while (
    projected.length > 1 &&
    JSON.stringify(projected).length > MAX_RELEASES_CHARS
  ) {
    projected.shift();
    truncated = true;
  }

  return {
    releases: projected,
    // The provider's true total, so the model knows older entries exist — and, since
    // neither side paginates, that there is no way to page to them.
    release_count: releases.length,
    truncated,
  };
}
