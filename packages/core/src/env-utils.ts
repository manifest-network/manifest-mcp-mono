/**
 * Boolean-flavored env-var parsing, shared across packages.
 *
 * Promoted from `packages/agent` to `core` in ENG-268 once a second
 * consumer (`packages/fred`'s SSRF-guard gate) needed it — `packages/agent`
 * now re-exports this. Keeping one implementation avoids drift between the
 * two servers' `*_FETCH_GUARDED` parsing.
 */

import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse a boolean-flavored env var. Returns `defaultValue` when the env
 * var is unset, empty, or whitespace-only. Otherwise compares the
 * trimmed, lower-cased value against the canonical truthy / falsy sets:
 *
 *   truthy: '1', 'true',  'yes', 'on'
 *   falsy:  '0', 'false', 'no',  'off'
 *
 * An unrecognized non-empty value throws `ManifestMCPError(INVALID_CONFIG)`
 * naming `envName` — silently falling back to the default would defeat
 * the helper's purpose (e.g. `MANIFEST_FRED_FETCH_GUARDED=ture` would
 * silently no-op the SSRF guard the operator clearly intended to keep on).
 *
 * @param value - Raw env-var value (typically `process.env[envName]`).
 * @param defaultValue - Returned when `value` is `undefined`/empty/whitespace.
 * @param envName - Env var name; embedded in the diagnostic message
 *   when the value is unrecognized.
 */
export function parseBooleanEnv(
  value: string | undefined,
  defaultValue: boolean,
  envName: string,
): boolean {
  if (value === undefined) return defaultValue;
  const trimmed = value.trim();
  if (trimmed.length === 0) return defaultValue;
  const normalised = trimmed.toLowerCase();
  if (TRUTHY.has(normalised)) return true;
  if (FALSY.has(normalised)) return false;
  throw new ManifestMCPError(
    ManifestMCPErrorCode.INVALID_CONFIG,
    `${envName}: unrecognized boolean value "${value}". ` +
      "Accepted truthy: '1', 'true', 'yes', 'on'. " +
      "Accepted falsy: '0', 'false', 'no', 'off'. " +
      'Case-insensitive; leading / trailing whitespace ignored.',
  );
}
