import { execFileSync } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §8 boundary meta-tests (ENG-309) — the guards dependency-cruiser CANNOT express as import-edge
 * rules, plus the proof that the import-edge rules in `.dependency-cruiser.cjs` actually bite.
 *
 * (1) Brand-cast chokepoint: the two sanctioned brand-producer families (`parse*` + `as*`) live ONLY
 *     in `core/src/brands.ts`, so the lone `as Brand` trust-cast stays confined there (spec §5.0/§8).
 *     A type assertion (`x as Address`) produces NO import edge, so depcruise can never see it — it
 *     ships here as a source grep.
 * (2) No `parse*` in the lcd-adapter read path: chain/codegen reads are branded via the `as*`
 *     trust-cast family only — never the re-validating `parse*` family (chain output is the source of
 *     truth; re-validation costs perf and throws on non-canonical ids — spec §8 / §5.1).
 * (3) The dependency-cruiser known-bad fixtures (tools/depcruise-fixtures/) MUST be flagged, and the
 *     real tree MUST cruise clean — pinning that the import-edge rules are live, not vacuous.
 *
 * Scoped to PRODUCTION source (`*.ts` excluding `*.test.ts`/`*.test-d.ts`): test fixtures that
 * construct branded values for mocks are not the shipped trust-cast producer, exactly as the
 * dependency-cruiser browser/boundary rules exempt test files.
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

/** All production `*.ts` under packages/ (excludes *.test.ts / *.test-d.ts and dist/node_modules). */
function productionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test-d.ts')
      ) {
        out.push(full);
      }
    }
  };
  walk(join(ROOT, 'packages'));
  return out;
}

const BRAND_CAST_RE = /\bas (?:Address|LeaseUuid|ProviderUuid|SkuUuid|Fqdn)\b/;
const PARSE_CALL_RE = /\bparse[A-Z][A-Za-z]*\s*\(/;

describe('§8 brand-cast + lcd-adapter chokepoint (grep meta-test; ENG-309)', () => {
  it('the `as Brand` trust-cast appears ONLY in core/src/brands.ts', () => {
    const offenders = productionSources().filter((file) =>
      BRAND_CAST_RE.test(readFileSync(file, 'utf8')),
    );
    const relative = offenders.map((f) => f.slice(ROOT.length + 1)).sort();
    expect(relative).toEqual(['packages/core/src/brands.ts']);
  });

  it('the lcd-adapter read path never calls a `parse*` constructor (as* trust-cast only)', () => {
    const adapter = readFileSync(
      join(ROOT, 'packages/core/src/lcd-adapter.ts'),
      'utf8',
    );
    // Strip line comments so a stray "parsed" in prose can't false-positive.
    const code = adapter.replace(/\/\/.*$/gm, '');
    expect(PARSE_CALL_RE.test(code)).toBe(false);
  });
});

describe('dependency-cruiser import-edge rules bite (fixtures fail, real tree clean; ENG-309)', () => {
  const fixturesDir = join(ROOT, 'tools/depcruise-fixtures');

  it('flags every known-bad fixture (non-zero exit)', () => {
    let exitCode = 0;
    try {
      execFileSync(
        'npx',
        [
          'depcruise',
          'pkg-src',
          'browser-src',
          '--config',
          '.dependency-cruiser.fixtures.cjs',
        ],
        { cwd: fixturesDir, stdio: 'pipe' },
      );
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? -1;
    }
    // depcruise's exit code is the number of error-severity violations (here: 3 fixtures).
    expect(exitCode).toBeGreaterThan(0);
  });

  it('cruises the real tree clean (zero violations, exit 0)', () => {
    expect(() =>
      execFileSync(
        'npx',
        ['depcruise', 'packages', '--config', '.dependency-cruiser.cjs'],
        {
          cwd: ROOT,
          stdio: 'pipe',
        },
      ),
    ).not.toThrow();
  });

  // POSITIVE CONTROL (BLOCKER-2): the fixtures step above cruises `.dependency-cruiser.fixtures.cjs`
  // (no `exclude`), so it proves the regex but NOT the live PRODUCTION config — under which an
  // unanchored `exclude:/dist/` once made `manifestjs-types-chokepoint` a silent no-op (the rule's
  // only `to` target, the node_modules codegen `.../dist/.../types.js`, was dropped from the graph).
  // This injects a known-bad downstream codegen-TYPE import into a production source file, cruises the
  // REAL config, and asserts the chokepoint rule actually fires — so a future re-broadening of
  // `exclude` cannot revive the no-op silently.
  it('manifestjs-types-chokepoint FIRES on a downstream codegen-type import (PRODUCTION config)', () => {
    const probe = join(ROOT, 'packages/lease/src/__dcprobe_chokepoint.ts');
    writeFileSync(
      probe,
      "import type { Lease } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';\n" +
        'export type _Probe = Lease;\n',
    );
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(
        'npx',
        ['depcruise', 'packages', '--config', '.dependency-cruiser.cjs'],
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? -1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    } finally {
      rmSync(probe, { force: true });
    }
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('manifestjs-types-chokepoint');
  });
});
