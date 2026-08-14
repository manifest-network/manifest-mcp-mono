import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/**
 * Wire key-set capture against the live devnet Fred (ENG-638).
 *
 * The rest of the suite checks that mono behaves; this checks that mono's
 * PICTURE of Fred is still accurate. Those are different failures, and only the
 * second one caused ENG-638: Fred removed `last_error`, mono kept reading it,
 * and every unit fixture agreed with mono rather than with the provider, so CI
 * stayed green through the break.
 *
 * Deliberately asserts key SETS, not values. Values are environment-dependent
 * and would make this flaky; the shape is the contract, and the shape is what
 * silently moved.
 */

interface GoldenEntry {
  readonly endpoint: string;
  readonly observed_via: string;
  readonly always: readonly string[];
  readonly sometimes: readonly string[];
  readonly mono_strips: readonly string[];
  /**
   * Keys mono ADDS that Fred never sends (e.g. a derived `next_step`, or a
   * `manifest_bytes` measuring a blob mono strips). They are observed through a
   * projection, so they must count as known — otherwise they read as an unmodelled
   * provider field, which is the opposite of the truth.
   */
  readonly mono_adds: readonly string[];
}

const GOLDEN_PATH = fileURLToPath(
  new URL('../fred-wire-golden.json', import.meta.url),
);

const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<
  string,
  GoldenEntry
>;

/**
 * Assert an observed key set against the recorded golden.
 *
 * Two independent failures, each pointing at a different fix:
 *
 *  - A `always` key is MISSING -> the provider stopped sending something mono
 *    depends on. This is the ENG-508 shape. Fix the client.
 *  - An UNKNOWN key appeared -> the provider grew a field mono does not model.
 *    Decide whether to surface it, then record it in the golden.
 *
 * Never "fix" a failure by editing the golden first; that just re-hides the
 * drift this exists to expose.
 */
export function assertWireKeys(
  surface: keyof typeof golden & string,
  observed: readonly string[],
): void {
  const entry = golden[surface];
  if (entry === undefined) {
    throw new Error(
      `fred-wire-golden.json has no "${surface}" entry — the test and the golden disagree about what is being captured`,
    );
  }

  // Guard against a vacuous pass: an empty observation would satisfy the
  // unknown-key check trivially and quietly assert nothing.
  expect(
    observed.length,
    `${surface}: observed no keys at all — the capture is not seeing the response`,
  ).toBeGreaterThan(0);

  const missing = entry.always.filter((k) => !observed.includes(k));
  expect(
    missing,
    `${surface} (${entry.endpoint}, via ${entry.observed_via}): the provider no longer sends ${missing.join(', ')}. ` +
      'If mono reads any of these, that is a client break — see ENG-638. Do not edit the golden to silence it.',
  ).toEqual([]);

  const known = new Set([
    ...entry.always,
    ...entry.sometimes,
    ...entry.mono_strips,
    ...entry.mono_adds,
  ]);
  const unknown = observed.filter((k) => !known.has(k));
  expect(
    unknown,
    `${surface} (${entry.endpoint}): the provider sent unmodelled key(s) ${unknown.join(', ')}. ` +
      'Fred grew a field mono does not know about — decide whether to surface it, then record it in e2e/fred-wire-golden.json.',
  ).toEqual([]);
}
