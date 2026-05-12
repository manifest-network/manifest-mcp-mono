/**
 * Secret-key denylist + prototype-pollution guard. Used by
 * `verify-recover.ts` to scrub a verifier's diagnostic payload before it
 * reaches the host callback (or the journal record in ENG-124).
 *
 * Ports two pieces of the plugin's CJS:
 *
 * - `SECRET_KEY_DENYLIST` regex from `manifest-agent-plugin/scripts/_journal.cjs`
 *   (line 127). Case-insensitive substring match on KEY names only — values
 *   are never inspected. Narrow on purpose: covers the high-confidence
 *   sensitive shapes seen in this plugin's flows (mnemonic + keyfile
 *   password) plus credential-shaped suffixes that catch obvious skill-
 *   author mistakes (`api[_-]?key`, `private[_-]?key`, `secret[_-]?key`,
 *   `auth[_-]?token`, `bearer[_-]?token`). The blanket `token` and `secret`
 *   keywords are NOT here — this is a blockchain plugin where `gas_token`,
 *   `fee_token`, `token_id`, `token_symbol` are legitimate non-sensitive
 *   field names.
 *
 * - `stripDenylist` recursive walker from `manifest-agent-plugin/scripts/verify-recover.cjs`
 *   (lines 200-216). Walks objects + arrays; drops any key matching the
 *   denylist regex; ALSO skips the three prototype-pollution-capable keys
 *   `__proto__`, `constructor`, `prototype` because `JSON.parse`
 *   materializes them as own properties that a bare `out[k] = v`
 *   assignment would treat as a prototype mutation.
 *
 * Byte-match contract: the regex source must equal
 * `_journal.cjs`'s SECRET_KEY_DENYLIST exactly. qa-engineer's PR-1 review
 * checks this.
 */

export const SECRET_KEY_DENYLIST =
  /(mnemonic|password|private[_-]?key|secret[_-]?key|api[_-]?key|auth[_-]?token|bearer[_-]?token)/i;

export const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Recursively walk a value and remove any object keys that:
 *   - Match `SECRET_KEY_DENYLIST` (case-insensitive substring on key name), or
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
      if (SECRET_KEY_DENYLIST.test(k)) continue;
      out[k] = stripDenylist(v);
    }
    return out;
  }
  return value;
}
