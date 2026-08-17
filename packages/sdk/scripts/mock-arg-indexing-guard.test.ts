import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * End-indexed mock-argument reads are banned repo-wide (ENG-706).
 *
 * Reading an argument by its distance from the END of a recorded call —
 * `spy.mock.lastCall?.at(-2)` — is not merely brittle. When the callee grows a trailing
 * parameter the index silently slides onto a DIFFERENT argument, so the assertion keeps
 * passing while checking something else entirely. An exact-arity `toHaveBeenCalledWith`
 * at least fails loudly; this class produces a false pass, and four of them sat in
 * `packages/fred/src/server.test.ts` guarding the SSRF wiring.
 *
 * Read arguments by a positive index counted from the START instead, or destructure the
 * recorded call. Both are stable under an appended parameter, and both fail loudly if one
 * is inserted mid-list — which is the outcome we want.
 *
 * Ships as a source grep for the same reason `cast-guard.test.ts` does: the hazard is a
 * lexical shape, not an import edge, so dependency-cruiser can never see it, and Biome has
 * no rule for it. Point (3) below is the non-vacuity control — a rule that has never been
 * proven to bite is not a guard.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Walk up from this file to the monorepo root (the dir holding `.dependency-cruiser.cjs`). */
function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    try {
      statSync(join(dir, '.dependency-cruiser.cjs'));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(
    'could not locate repo root (.dependency-cruiser.cjs not found walking up)',
  );
}

const ROOT = repoRoot();

/** This file is scanned by its own rule, and holds the banned shapes as fixtures. */
const SELF = fileURLToPath(import.meta.url);

/** Every `*.test.ts` under `packages/` and `examples/` (excludes dist/node_modules and SELF). */
function testSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.name.endsWith('.test.ts') && full !== SELF) {
        out.push(full);
      }
    }
  };
  for (const root of ['packages', 'examples']) walk(join(ROOT, root));
  return out;
}

/**
 * An end-index into ONE recorded call's argument list.
 *
 * Matches `<...>.lastCall`, `<...>.calls[<i>]` and `<...>.calls.at(<i>)` followed (through an
 * optional `?.`) by `.at(-…)`. Deliberately does NOT match a bare `.mock.calls.at(-1)`, which
 * end-indexes the CALLS array to pick the last call and is perfectly stable — the arguments are
 * then reached by a positive index. That distinction is the whole point: ~8 such sites exist and
 * "fixing" them is churn.
 */
const END_INDEXED_ARG_RE =
  /\.(?:lastCall|calls\s*\[[^\]]*\]|calls\s*\.\s*at\s*\([^)]*\))\s*\??\s*\.\s*at\s*\(\s*-/;

describe('no end-indexed mock-argument reads (grep meta-test; ENG-706)', () => {
  it('(1) finds test files to scan', () => {
    // Total vacuity guard: a broken walk would make every check below pass trivially.
    const files = testSources();
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((f) => f.endsWith(join('fred', 'src', 'server.test.ts'))),
    ).toBe(true);
  });

  it('(2) no test reads a call argument by end-index', () => {
    const offenders: string[] = [];
    for (const file of testSources()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (END_INDEXED_ARG_RE.test(line)) {
          offenders.push(
            `${relative(ROOT, file).split(sep).join('/')}:${i + 1}: ${line.trim()}`,
          );
        }
      });
    }
    expect(
      offenders,
      'Read the argument by a positive index from the START of the call, or destructure the\n' +
        'recorded call. An end-index silently slides onto a different argument when the callee\n' +
        'grows a trailing parameter, so the assertion passes while checking the wrong thing.\n' +
        'See ENG-706.\n\nOffenders:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('(3) the matcher actually bites, and spares the safe shapes', () => {
    // Positive controls — every banned form, including the two that were live on `main`.
    for (const banned of [
      "expect(typeof mockGetLeaseProvision.mock.lastCall?.at(-2)).toBe('function');",
      'expect(mockGetLeaseReleases.mock.lastCall?.at(-1)).toBe(false);',
      'const x = spy.mock.lastCall.at(-1);',
      'const y = spy.mock.calls[0].at(-2);',
      'const z = spy.mock.calls[0]?.at(-2);',
      'const w = spy.mock.calls.at(-1)?.at(-1);',
    ]) {
      expect(END_INDEXED_ARG_RE.test(banned), banned).toBe(true);
    }

    // Negative controls — end-index on the CALLS array then a positive arg index, positive
    // argument indexes, and `.at(-1)` on an ordinary result array. All stable; leave them alone.
    for (const allowed of [
      'const opts = mockWaitForAppReady.mock.calls.at(-1)?.[2];',
      'const lastCall = vi.mocked(core.resolveSku).mock.calls.at(-1);',
      'expect(spy.mock.lastCall?.[0]?.fetch).toBe(globalThis.fetch);',
      'const [, , , fetchFn] = spy.mock.lastCall!;',
      'expect(out.releases.at(-1)?.version).toBe(30);',
    ]) {
      expect(END_INDEXED_ARG_RE.test(allowed), allowed).toBe(false);
    }
  });
});
