import { execFileSync } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
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
 * (4) Every rule in the PRODUCTION config fires on a probe written into a real package (ENG-641).
 *     A rule that has never been proven to bite is not a guard; both DAG rules shipped unfireable
 *     because they were the only two with neither a fixture nor a positive control.
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

/** Run depcruise from the repo root, capturing its exit code and combined output. */
function cruise(args: string[]): { exitCode: number; output: string } {
  try {
    const output = execFileSync('npx', ['depcruise', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return { exitCode: 0, output };
  } catch (err) {
    // depcruise's exit code is its count of error-severity violations.
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? -1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    };
  }
}

const PRODUCTION_CRUISE = [
  'packages',
  'examples',
  '--config',
  '.dependency-cruiser.cjs',
];

// Cruised from the REPO ROOT, not from the fixtures dir: the DAG rules' `to` matchers are anchored
// `^packages/…`, and depcruise reports module paths relative to cwd (ENG-641).
const FIXTURES_CRUISE = [
  'tools/depcruise-fixtures/pkg-src',
  'tools/depcruise-fixtures/browser-src',
  'tools/depcruise-fixtures/example-src',
  'tools/depcruise-fixtures/core-src',
  'tools/depcruise-fixtures/fred-src',
  '--config',
  'tools/depcruise-fixtures/.dependency-cruiser.fixtures.cjs',
];

/**
 * POSITIVE CONTROL: write a known-bad probe into a REAL package's source, cruise the PRODUCTION
 * config (not a re-anchored clone), and hand back the result. The probe is always removed.
 *
 * This is the only proof that survives a resolution change. The fixtures step cruises a clone whose
 * `from` anchors are rewritten, so it can prove a `to` matcher's regex while the production config
 * quietly resolves real cross-package imports somewhere that matcher can never reach — which is
 * exactly how both DAG rules stayed green while gating nothing (ENG-641), and how an unanchored
 * `exclude:/dist/` once no-op'd `manifestjs-types-chokepoint` before that.
 */
function cruiseWithProbe(
  relativeProbePath: string,
  source: string,
): { exitCode: number; output: string } {
  const probe = join(ROOT, relativeProbePath);
  writeFileSync(probe, source);
  try {
    return cruise(PRODUCTION_CRUISE);
  } finally {
    rmSync(probe, { force: true });
  }
}

/** A type-only probe import — `tsPreCompilationDeps: true` keeps the edge visible. */
function typeProbe(specifier: string, exported: string): string {
  return (
    `import type { ${exported} } from '${specifier}';\n` +
    `export type _Probe = ${exported};\n`
  );
}

const productionRuleNames: string[] = createRequire(import.meta.url)(
  join(ROOT, '.dependency-cruiser.cjs'),
).forbidden.map((rule: { name: string }) => rule.name);

describe('dependency-cruiser import-edge rules bite (fixtures fail, real tree clean; ENG-309)', () => {
  it('flags a known-bad fixture for EVERY production rule (non-zero exit)', () => {
    const { exitCode, output } = cruise(FIXTURES_CRUISE);
    expect(exitCode).toBeGreaterThan(0);
    // Completeness, not just "something failed": a production rule with no fixture is how a rule
    // that could never fire stayed green for its whole life (ENG-641). Adding a rule without a
    // fixture must fail here.
    const unproven = productionRuleNames.filter(
      (name) => !output.includes(name),
    );
    expect(unproven, output).toEqual([]);
  });

  // The fixture-completeness guard above has a twin: a rule can have a fixture and still lack a
  // PRODUCTION positive control, which is the weaker half of the proof (a fixture only ever exercises
  // a re-anchored clone of the matcher). That gap is not hypothetical — it shipped in this very PR,
  // where 5 of 7 rules had probes while a comment claimed all of them did. Enforce it mechanically
  // instead of in prose: every rule must be named by a `toContain(...)` in one of the probe tests
  // below. Matched against whitespace-stripped source so a reformat that wraps the call still counts.
  it('has a PRODUCTION-config positive control for EVERY production rule', () => {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8').replace(
      /\s+/g,
      '',
    );
    const unproven = productionRuleNames.filter(
      (name) => !self.includes(`toContain('${name}'`),
    );
    expect(unproven).toEqual([]);
  });

  it('cruises the real tree clean (zero violations, exit 0)', () => {
    const { exitCode, output } = cruise(PRODUCTION_CRUISE);
    expect(exitCode, output).toBe(0);
  });

  // POSITIVE CONTROL (BLOCKER-2): the fixtures step above cruises `.dependency-cruiser.fixtures.cjs`
  // with re-anchored `from`s, so it proves the regex but NOT the live PRODUCTION config — under which
  // an unanchored `exclude:/dist/` once made `manifestjs-types-chokepoint` a silent no-op (the rule's
  // only `to` target, the node_modules codegen `.../dist/.../types.js`, was dropped from the graph).
  // This injects a known-bad downstream codegen-TYPE import into a production source file, cruises the
  // REAL config, and asserts the chokepoint rule actually fires — so a future re-broadening of
  // `exclude` cannot revive the no-op silently.
  it('manifestjs-types-chokepoint FIRES on a downstream codegen-type import (PRODUCTION config)', () => {
    const { exitCode, output } = cruiseWithProbe(
      'packages/lease/src/__dcprobe_chokepoint.ts',
      typeProbe(
        '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js',
        'Lease',
      ),
    );
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('manifestjs-types-chokepoint');
  });

  // POSITIVE CONTROL (Task B1 / MF-1 / MF-3): as above, but for the compose-only ALLOWLIST — the
  // fixtures step proves its `to` matcher, not the live `from: ^examples/[^/]+/src` anchor. Injects a
  // stray dep outside the SDK+manifestjs allowlist into a REAL example source file.
  it('example-composes-only-sdk FIRES on a stray non-allowlisted import (PRODUCTION config)', () => {
    const { exitCode, output } = cruiseWithProbe(
      'examples/sdk-acceptance/src/__dcprobe_compose.ts',
      "import '@cosmjs/proto-signing';\nexport const _probe = 1;\n",
    );
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('example-composes-only-sdk');
  });

  // POSITIVE CONTROLS for the package DAG (ENG-641). These two rules encode the repo's central
  // architectural invariant and were the ONLY rules here with neither a fixture nor a positive
  // control — which is exactly how they shipped unfireable: a package-name import resolved into
  // `packages/<pkg>/dist/` (deleted by `exclude`) or, for a subpath, did not resolve at all, so
  // `to: ^packages/(fred|agent-core)/src` had no reachable target and `npm run depcruise` reported
  // `no dependency violations found` on a tree containing the exact violation it forbids.
  //
  // Each probe imports BY PACKAGE NAME — the only form anyone writes, and the form that was blind.
  // A relative `../../fred/src/x.js` probe would have passed all along and proven nothing.
  it('no-core-to-fred-or-agentcore FIRES on core -> fred (PRODUCTION config)', () => {
    const { exitCode, output } = cruiseWithProbe(
      'packages/core/src/__dcprobe_dag_fred.ts',
      typeProbe('@manifest-network/manifest-mcp-fred', 'ProviderApiError'),
    );
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('no-core-to-fred-or-agentcore');
  });

  // Second arm of the same rule's `to` matcher — a fred-only probe would leave it unproven.
  it('no-core-to-fred-or-agentcore FIRES on core -> agent-core (PRODUCTION config)', () => {
    const { exitCode, output } = cruiseWithProbe(
      'packages/core/src/__dcprobe_dag_agent_core.ts',
      typeProbe('@manifest-network/manifest-agent-core', 'AgentCoreRuntime'),
    );
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('no-core-to-fred-or-agentcore');
  });

  it('no-fred-to-agentcore FIRES on fred -> agent-core (PRODUCTION config)', () => {
    const { exitCode, output } = cruiseWithProbe(
      'packages/fred/src/__dcprobe_dag_agent_core.ts',
      typeProbe('@manifest-network/manifest-agent-core', 'AgentCoreRuntime'),
    );
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('no-fred-to-agentcore');
  });

  // The §9 example guard from the first-party side: once package names resolve to `src`, a workspace
  // sibling is a `local` edge, invisible to `example-composes-only-sdk`'s `dependencyTypes: npm…`.
  it('no-example-to-non-sdk-package FIRES on example -> fred (PRODUCTION config)', () => {
    const { exitCode, output } = cruiseWithProbe(
      'examples/sdk-acceptance/src/__dcprobe_workspace.ts',
      typeProbe('@manifest-network/manifest-mcp-fred', 'ProviderApiError'),
    );
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('no-example-to-non-sdk-package');
  });

  // POSITIVE CONTROLS for the browser-safety rules. These are VALUE imports, not `import type`: the
  // rules turn on `dependencyTypesNot: ['dynamic-import']`, i.e. it is the STATIC edge that breaks
  // the browser build (a runtime-gated `import('node:fs')` is allowed and must stay allowed).
  // The probe path must also dodge the rules' `pathNot` exemptions (guarded-fetch, /node.ts,
  // /server/, *.test.ts) — `__dcprobe_browser_*.ts` in `core/src` does.
  it('no-static-node-in-browser-src FIRES on a static node: import (PRODUCTION config)', () => {
    const { exitCode, output } = cruiseWithProbe(
      'packages/core/src/__dcprobe_browser_node.ts',
      "import { readFileSync } from 'node:fs';\nexport const _probe = readFileSync;\n",
    );
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('no-static-node-in-browser-src');
  });

  it('no-static-undici-ws-in-browser-src FIRES on a static undici import (PRODUCTION config)', () => {
    const { exitCode, output } = cruiseWithProbe(
      'packages/core/src/__dcprobe_browser_undici.ts',
      "import { fetch } from 'undici';\nexport const _probe = fetch;\n",
    );
    expect(exitCode).toBeGreaterThan(0);
    expect(output).toContain('no-static-undici-ws-in-browser-src');
  });
});
