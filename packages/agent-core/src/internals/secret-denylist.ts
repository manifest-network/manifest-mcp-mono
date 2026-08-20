/**
 * Prototype-pollution guard + the *action* half of secret scrubbing. Used by
 * `verify-recover.ts` to scrub a verifier's diagnostic payload before it
 * reaches the host callback (or the journal record in ENG-124).
 *
 * The **policy** — which key names denote a secret — is NOT here. It lives
 * once, in core's `isSensitiveKey`, and is shared with `sanitizeForLogging`.
 * This module supplies only the action: core *redacts the value* in place,
 * this walker *drops the key entirely*. Different actions, one policy.
 *
 * Before ENG-747 / ENG-271(b) this module carried its own parallel regex. The
 * two lists drifted — core redacted bare `secret` while this one deliberately
 * did not, and core missed every camelCase spelling that this regex caught.
 * That drift was the bug, so the list is gone rather than re-synchronized.
 *
 * The blanket `token` and `key` keywords remain excluded by that shared policy,
 * for the same blockchain-domain reason this module always gave: `gas_token`,
 * `fee_token`, `token_id`, `token_symbol` and `pub_key` are legitimate
 * non-sensitive field names.
 *
 * Two exports:
 *
 * - `PROTOTYPE_POLLUTION_KEYS` — the three constructor-related key names.
 *
 * - `stripDenylist` — recursive walker over objects + arrays; drops any key
 *   for which core's `isSensitiveKey` is true; ALSO skips the three
 *   prototype-pollution-capable keys `__proto__`, `constructor`, `prototype`
 *   because `JSON.parse` materializes them as own properties that a bare
 *   `out[k] = v` assignment would treat as a prototype mutation.
 */

import { isSensitiveKey } from '@manifest-network/manifest-mcp-core';

export const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Recursively walk a value and remove any object keys that:
 *   - Are sensitive per core's `isSensitiveKey` (the shared policy), or
 *   - Are one of the prototype-pollution keys (`__proto__`, `constructor`,
 *     `prototype`).
 *
 * Arrays are walked element-wise. Primitives (string/number/boolean/null/
 * undefined) pass through untouched.
 *
 * Returns `unknown` because the structural shape changes: object inputs may
 * have fewer keys than they started with. Callers narrow at use sites.
 */
export function stripDenylist(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => stripDenylist(v));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PROTOTYPE_POLLUTION_KEYS.has(k)) continue;
      if (isSensitiveKey(k)) continue;
      out[k] = stripDenylist(v);
    }
    return out;
  }
  return value;
}
