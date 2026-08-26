import { sanitizeForDisplay } from '@manifest-network/manifest-mcp-core';

/**
 * The failure `reason` values Fred defines today (provider
 * `internal/backend/reason.go`, ENG-508).
 *
 * This list is a CONVENIENCE, not a validator. Fred documents the set as OPEN
 * and add-only: "consumers MUST tolerate an unrecognized value and fall back to
 * the human message." Nothing in this package may reject, drop, or
 * exhaustively switch on a `reason` because it is absent from this array — the
 * only sanctioned use is deciding whether curated guidance exists for a value.
 */
export const FRED_FAILURE_REASONS = [
  'ContainerExited',
  'ImagePullFailed',
  'Internal',
  'RestartFailed',
  'UpdateFailed',
  'RestoreFailed',
  'VolumeCleanupExhausted',
  'CleanupFailed',
  'Unknown',
] as const;

/**
 * A Fred failure reason.
 *
 * Deliberately an OPEN union: the `(string & {})` member keeps every known
 * value autocompleting and narrowable while leaving the type assignable from
 * (and to) `string`, so a provider running a newer Fred than this client cannot
 * cause a type error. Closing this union would reproduce the forward-
 * compatibility trap that made Kubernetes strip enums from its OpenAPI snapshot
 * (kubernetes#109177) — do not close it.
 */
export type FredFailureReason =
  | (typeof FRED_FAILURE_REASONS)[number]
  | (string & {});

/** A `reason` this client has curated guidance for. Never a rejection gate. */
export function isKnownFailureReason(
  reason: string,
): reason is (typeof FRED_FAILURE_REASONS)[number] {
  return (FRED_FAILURE_REASONS as readonly string[]).includes(reason);
}

/**
 * Either wire shape's failure fields. `last_error` (/status, /provision) and
 * `error` (/releases) are the pre-ENG-508 spellings of the same signal; they
 * never co-occur on one response type.
 */
export interface FredFailureSource {
  readonly reason?: string;
  readonly message?: string;
  /** @deprecated pre-ENG-508 /status + /provision */
  readonly last_error?: string;
  /** @deprecated pre-ENG-508 /releases */
  readonly error?: string;
}

/** The canonical failure signal, with the wire era resolved away. */
export interface FredFailure {
  /** Raw wire value, VERBATIM — including values this client does not know. */
  readonly reason?: string;
  /** Curated human summary, or the legacy verbose text when that is all we got. */
  readonly message?: string;
  /** True when the message came from the deprecated `last_error`/`error`. */
  readonly legacy: boolean;
}

/**
 * Non-empty string, or `undefined`.
 *
 * Built-in HTTP adapters now schema-validate these fields, but this helper is a
 * public boundary that also accepts directly constructed/legacy data. Keep the
 * runtime guard so a non-string can never flow into interpolation. Empty string
 * counts as absent, matching Fred's `omitempty` and `parseFredWsEvent`'s existing
 * `o.error !== ''` guard.
 */
function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Resolve the failure signal from EITHER wire era (ENG-638).
 *
 * Providers upgrade independently of this client, so both shapes are live at
 * once: prefer ENG-508's curated `reason`/`message`, fall back to the
 * deprecated `last_error`/`error`. Returns `undefined` when the response
 * carries no failure signal at all — which is the common case, since Fred omits
 * both fields on a healthy lease.
 *
 * PURE: no sanitization. Callers that put the result in model/human context go
 * through `sanitizeFailureFields`; callers that need the raw value for logic
 * (or for an operator-facing error message) use this directly.
 *
 * An unrecognized `reason` is passed through verbatim rather than dropped or
 * replaced — that IS the open-set tolerance Fred mandates.
 */
export function describeFredFailure(
  src: FredFailureSource,
): FredFailure | undefined {
  const reason = nonEmpty(src.reason);
  const curated = nonEmpty(src.message);
  const legacyText = nonEmpty(src.last_error) ?? nonEmpty(src.error);
  const message = curated ?? legacyText;
  if (reason === undefined && message === undefined) return undefined;
  return {
    ...(reason !== undefined && { reason }),
    ...(message !== undefined && { message }),
    legacy: curated === undefined && legacyText !== undefined,
  };
}

/**
 * One-line human tail for an error message: `"Reason: message"`, `"Reason"`,
 * `"message"`, or `undefined` when there is no signal.
 *
 * Not sanitized — this feeds `ProviderApiError.message`, which is parity with
 * the raw `status.last_error` interpolation it replaces, and post-ENG-508 the
 * value is strictly safer than what was interpolated before (Fred guarantees no
 * host paths or raw command output in `message`).
 */
export function failureDetail(src: FredFailureSource): string | undefined {
  const failure = describeFredFailure(src);
  if (failure === undefined) return undefined;
  return [failure.reason, failure.message]
    .filter((part): part is string => part !== undefined)
    .join(': ');
}

/**
 * Cap for `message`. The 64-code-point default would bisect Fred's composed
 * rollback suffixes and image references, losing the actionable half; the value
 * is curated (no host paths, no raw command output), so a longer cap is a
 * context-budget bound rather than a security one. Matches the provider-text
 * cap already used at `tools/restoreApp.ts`.
 */
const MESSAGE_MAX = 256;

/**
 * Project + sanitize the provider-controlled failure fields for AI-facing
 * output (ENG-638; ENG-555/ENG-600 precedent — see `tools/sanitizeRetention.ts`).
 *
 * Both `reason` and `message` are provider-controlled strings that reach model
 * context, so they are run through `sanitizeForDisplay` (NFC-normalize, strip
 * control/format/separator chars, collapse whitespace). Unlike
 * `sanitizeRetentionFields`' validate-or-drop `retained_until`, every key here
 * is sanitize-ALWAYS — an unrecognized `reason` must survive, because dropping
 * it would break the open-set tolerance Fred mandates.
 *
 * The legacy `last_error`/`error` are echoed back sanitized so a caller reading
 * our own output on the deprecated key keeps working during the fleet upgrade.
 *
 * Returns only the keys present on the input. Empty strings are OMITTED rather
 * than sanitized: `sanitizeForDisplay('')` returns the `(hidden)` placeholder,
 * which would report a redaction that never happened on Fred's legitimately
 * empty `message`.
 */
export function sanitizeFailureFields(src: FredFailureSource): {
  reason?: string;
  message?: string;
  last_error?: string;
  error?: string;
} {
  const clean = (v: unknown, max?: number) => {
    const raw = nonEmpty(v);
    return raw === undefined ? undefined : sanitizeForDisplay(raw, max);
  };
  // `reason` is identifier-shaped (longest defined value is 22 chars) → default cap.
  const reason = clean(src.reason);
  const message = clean(src.message, MESSAGE_MAX);
  const lastError = clean(src.last_error, MESSAGE_MAX);
  const error = clean(src.error, MESSAGE_MAX);
  return {
    ...(reason !== undefined && { reason }),
    // Fall back to the legacy text so a pre-ENG-508 provider still populates
    // the canonical key, mirroring describeFredFailure.
    ...((message ?? lastError ?? error) !== undefined && {
      message: message ?? lastError ?? error,
    }),
    ...(lastError !== undefined && { last_error: lastError }),
    ...(error !== undefined && { error }),
  };
}
