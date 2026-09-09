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

const BRANDS_FILE = 'packages/core/src/brands.ts';

/**
 * Brand type names, read from `brands.ts` itself (ENG-644). DERIVED, never hand-listed: the
 * previous literal alternation had drifted — it omitted `Tenant` (`= Address`), so `x as Tenant`
 * was a trust-cast the guard could not see. Same drift that made the dependency-cruiser DAG rules
 * vacuous (ENG-641), and a sixth brand would have been silently unguarded the day it landed.
 *
 * Matches both forms `brands.ts` uses: `export type X = Brand<...>` and the transparent alias
 * `export type Tenant = Address`.
 */
function brandTypeNames(): string[] {
  const source = readFileSync(join(ROOT, BRANDS_FILE), 'utf8');
  return [...source.matchAll(/^export type ([A-Z][A-Za-z0-9]*)\s*=/gm)].map(
    (m) => m[1],
  );
}

const BRAND_NAMES = brandTypeNames();
const BRAND_CAST_RE = new RegExp(`\\bas (?:${BRAND_NAMES.join('|')})\\b`);
const PARSE_CALL_RE = /\bparse[A-Z][A-Za-z]*\s*\(/;

describe('§8 brand-cast + lcd-adapter chokepoint (grep meta-test; ENG-309)', () => {
  // The derivation is now load-bearing, so prove it produced something and that the regex it built
  // actually matches a cast of EVERY brand it claims to cover. (Total vacuity is already caught by
  // the next test — a regex matching nothing would fail to find brands.ts itself — but this fails
  // with a far clearer message, and catches one name silently dropping out of the alternation.)
  it('derives the brand list from brands.ts and matches a cast of each', () => {
    expect(BRAND_NAMES.length).toBeGreaterThan(0);
    const unmatched = BRAND_NAMES.filter(
      (name) => !BRAND_CAST_RE.test(`const x = y as ${name};`),
    );
    expect(unmatched).toEqual([]);
  });

  it('the `as Brand` trust-cast appears ONLY in core/src/brands.ts', () => {
    const offenders = productionSources().filter((file) =>
      BRAND_CAST_RE.test(readFileSync(file, 'utf8')),
    );
    const relative = offenders.map((f) => f.slice(ROOT.length + 1)).sort();
    expect(relative).toEqual([BRANDS_FILE]);
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

// Whole-workspace resolution competes with V8 coverage and type workers in CI.
// The exhaustive probe cruise exceeded the previous 30 s cap under that load;
// retain a finite hang guard without treating host throughput as an assertion.
const CRUISE_TIMEOUT_MS = 60_000;

/** Run depcruise from the repo root, capturing its exit code and combined output. */
function cruise(args: string[]): { exitCode: number; output: string } {
  const started = Date.now();
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruise.mjs'),
        ...args,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: CRUISE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return { exitCode: 0, output };
  } catch (err) {
    // depcruise's exit code is its count of error-severity violations.
    const e = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      // A spawn/pipe failure can carry status 0; throwing is never a successful cruise.
      exitCode: e.status || -1,
      output: [
        `depcruise ${args.join(' ')} failed after ${Date.now() - started} ms (limit ${CRUISE_TIMEOUT_MS} ms)`,
        e.message ?? String(err),
        e.stdout ?? '',
        e.stderr ?? '',
      ].join('\n'),
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
  'tools/depcruise-fixtures',
  '--config',
  'tools/depcruise-fixtures/.dependency-cruiser.fixtures.cjs',
];

/** Production probes are written together so exhaustive coverage needs only one real cruise. */
interface Probe {
  path: string;
  source: string;
  rule?: string;
  target?: string;
  forbidden?: boolean;
}
function cruiseWithProbes(probes: Probe[]): {
  exitCode: number;
  output: string;
} {
  const written: string[] = [];
  try {
    for (const probe of probes) {
      const path = join(ROOT, probe.path);
      writeFileSync(path, probe.source, { flag: 'wx' });
      written.push(path);
    }
    return cruise([...PRODUCTION_CRUISE, '--output-type', 'json']);
  } finally {
    for (const path of written) rmSync(path, { force: true });
  }
}

const require = createRequire(import.meta.url);
const productionRuleNames: string[] = require(
  join(ROOT, '.dependency-cruiser.cjs'),
).forbidden.map((rule: { name: string }) => rule.name);
const graph: Record<string, string[]> = require(
  join(ROOT, 'tools/depcruise/workspace-dag.cjs'),
).WORKSPACE_DEPENDENCIES;
const packageNames = Object.keys(graph);

const packageProbes: Probe[] = packageNames.flatMap((from) =>
  packageNames
    .filter((to) => to !== from)
    .map((to) => {
      const manifest: { name: string } = JSON.parse(
        readFileSync(join(ROOT, 'packages', to, 'package.json'), 'utf8'),
      );
      // The CLI package has no root barrel; its real bootstrap source is reachable via the alias.
      const specifier = manifest.name + (to === 'node' ? '/bootstrap' : '');
      return {
        path: `packages/${from}/src/__dcprobe_dag_${to}.ts`,
        source: `import type * as Target from '${specifier}';\nexport type _Probe = typeof Target;\n`,
        target: `packages/${to}/src/`,
        rule: `workspace-${from}-dependencies`,
        forbidden: !graph[from].includes(to),
      };
    }),
);

const boundaryProbes: Probe[] = [
  {
    path: 'packages/lease/src/__dcprobe_chokepoint.ts',
    source:
      "import type { Lease } from '@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.js';\nexport type _Probe = Lease;\n",
    rule: 'manifestjs-types-chokepoint',
  },
  {
    path: 'examples/sdk-acceptance/src/__dcprobe_compose.ts',
    source: "import '@cosmjs/proto-signing';\n",
    rule: 'example-composes-only-sdk',
  },
  {
    path: 'examples/sdk-acceptance/src/__dcprobe_workspace.ts',
    source:
      "import type * as Fred from '@manifest-network/manifest-mcp-fred';\nexport type _Probe = typeof Fred;\n",
    rule: 'no-example-to-non-sdk-package',
  },
  {
    path: 'packages/core/src/__dcprobe_browser_node.ts',
    source:
      "import { readFileSync } from 'node:fs';\nexport const _probe = readFileSync;\n",
    rule: 'no-static-node-in-browser-src',
  },
  {
    path: 'packages/core/src/__dcprobe_browser_undici.ts',
    source: "import { fetch } from 'undici';\nexport const _probe = fetch;\n",
    rule: 'no-static-undici-ws-in-browser-src',
  },
  {
    path: 'packages/core/src/__dcprobe_cycle_a.ts',
    source:
      "import { b } from './__dcprobe_cycle_b.js';\nexport const a = (): unknown => b;\n",
    rule: 'no-production-cycles',
  },
  {
    path: 'packages/core/src/__dcprobe_cycle_b.ts',
    source:
      "import { a } from './__dcprobe_cycle_a.js';\nexport const b = (): unknown => a;\n",
  },
];

interface CruiseGraph {
  summary: {
    violations: { from: string; to: string; rule: { name: string } }[];
  };
  modules: { source: string; dependencies: { resolved: string }[] }[];
}

describe('dependency-cruiser production architecture controls', {
  timeout: CRUISE_TIMEOUT_MS + 15_000,
}, () => {
  it('flags a known-bad fixture for every production rule', () => {
    const { exitCode, output } = cruise(FIXTURES_CRUISE);
    expect(exitCode).toBeGreaterThan(0);
    expect(
      productionRuleNames.filter((name) => !output.includes(name)),
      output,
    ).toEqual([]);
  });

  it('covers every production rule with an executable production probe', () => {
    const covered = new Set(
      [...packageProbes, ...boundaryProbes].map((probe) => probe.rule),
    );
    expect(productionRuleNames.filter((name) => !covered.has(name))).toEqual(
      [],
    );
    expect(packageProbes).toHaveLength(
      packageNames.length * (packageNames.length - 1),
    );
  });

  it('root TypeScript references include every workspace package and example', () => {
    const expected = ['packages', 'examples']
      .flatMap((base) =>
        readdirSync(join(ROOT, base))
          .filter((name) => {
            try {
              return statSync(join(ROOT, base, name, 'package.json')).isFile();
            } catch {
              return false;
            }
          })
          .map((name) => `${base}/${name}`),
      )
      .sort();
    const config: { references: { path: string }[] } = JSON.parse(
      readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'),
    );
    expect(config.references.map(({ path }) => path).sort()).toEqual(expected);
  });

  it('cruises the real tree clean', () => {
    const { exitCode, output } = cruise(PRODUCTION_CRUISE);
    expect(exitCode, output).toBe(0);
  });

  it('enforces every allowed/forbidden workspace pair and boundary rule with the production resolver', () => {
    const { exitCode, output } = cruiseWithProbes([
      ...packageProbes,
      ...boundaryProbes,
    ]);
    // The JSON reporter returns zero even for violations; inspect the structured verdict.
    expect(exitCode, output).toBe(0);
    const result: CruiseGraph = JSON.parse(output);
    expect(result.summary.violations.length).toBeGreaterThan(0);
    for (const probe of packageProbes) {
      const actual = result.modules.find(
        (module) => module.source === probe.path,
      );
      expect(
        actual?.dependencies.some((dependency) =>
          dependency.resolved.startsWith(probe.target!),
        ),
        probe.path,
      ).toBe(true);
      const violations = result.summary.violations.filter(
        (violation) =>
          violation.from === probe.path && violation.rule.name === probe.rule,
      );
      expect(violations.length > 0, probe.path).toBe(probe.forbidden);
    }
    for (const probe of boundaryProbes) {
      if (!probe.rule) continue;
      expect(
        result.summary.violations.some(
          (violation) =>
            violation.from === probe.path && violation.rule.name === probe.rule,
        ),
        probe.rule,
      ).toBe(true);
    }
  });
});
