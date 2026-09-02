// Root type-test harness (ENG-648). Run as `npm run check:type-tests`; CI runs it after the build.
//
// A type-level assertion (`expectTypeOf`, `assertType`) compiles to nothing. It fails only when
// tsc sees it, and Vitest hands tsc exactly one thing: `tsc -p <typecheck.tsconfig>` over that
// tsconfig's WHOLE program. Three gaps therefore make a type test pass while checking nothing,
// and none of them is visible in the run's output (it prints `Type Errors no errors` either way):
//
//   1. the invocation loads no `typecheck` block at all — a root `vitest run <path>` before the
//      root `vitest.config.mts` existed — so the file is either skipped or run as a runtime test;
//   2. the file carries type assertions but no `typecheck.include` collects it — the fred client
//      pins lived in a `.test.ts` for a year with only `npm run lint` able to fail them;
//   3. Vitest's glob collects the file but tsc's `include` never reaches it — Vitest globs with
//      `dot: true`, tsc's `include` skips dot-directories, and a package's `**/*.test-d.ts`
//      reaches outside the `src/**/*` its tsconfig compiles.
//
// One test per gap, plus sabotage tests proving each detector fires on a planted instance.
// Detection goes through Vitest's own resolver (`createVitest` + `globTestFiles`) rather than a
// re-implementation of its globbing, so the collected set here is the one a real run uses.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createVitest } from 'vitest/node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_CONFIG = join(ROOT, 'vitest.config.mts');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const WORKSPACE_GLOBS = ['packages', 'examples'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/** Identifiers whose presence makes a file a type-assertion file. Both are runtime no-ops. */
const TYPE_ASSERTION_IDENTIFIERS = new Set(['expectTypeOf', 'assertType']);

/**
 * True when the source uses a type-assertion identifier in CODE. Tokenized with TypeScript's
 * scanner (trivia skipped) so an `expectTypeOf` inside a comment or a string does not count —
 * a plain grep would pass on a commented-out assertion, which is its own kind of vacuous.
 */
function hasTypeAssertion(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    ts.LanguageVariant.Standard,
    source,
  );
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token === ts.SyntaxKind.Identifier &&
      TYPE_ASSERTION_IDENTIFIERS.has(scanner.getTokenValue())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Every file under `dir` that must be type-checked as a test: any `*.test-d.ts` (a type test by
 * name — one that no glob collects never runs at all), plus any `.ts` file whose code carries a
 * type assertion. Dot-directories are walked on purpose: Vitest collects from them and tsc does
 * not, which is gap 3.
 */
function findTypeAssertionFiles(dir) {
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        hits.push(...findTypeAssertionFiles(path));
      continue;
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.d.ts')
    )
      continue;
    if (
      entry.name.endsWith('.test-d.ts') ||
      hasTypeAssertion(readFileSync(path, 'utf8'))
    ) {
      hits.push(path);
    }
  }
  return hits.sort();
}

/** Directories of every workspace member that has its own `vitest.config.ts`. */
function workspaceConfigDirs() {
  const dirs = [];
  for (const group of WORKSPACE_GLOBS) {
    for (const entry of readdirSync(join(ROOT, group), {
      withFileTypes: true,
    })) {
      const dir = join(ROOT, group, entry.name);
      if (entry.isDirectory() && existsSync(join(dir, 'vitest.config.ts')))
        dirs.push(dir);
    }
  }
  return dirs.sort();
}

/** Root files of the tsconfig program, as absolute paths. `--showConfig` matches include/exclude without building the program. */
function tsconfigRootFiles(tsconfigPath) {
  const run = spawnSync(
    process.execPath,
    [TSC, '--showConfig', '-p', tsconfigPath],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  assert.equal(
    run.status,
    0,
    `tsc --showConfig failed for ${tsconfigPath}:\n${run.stdout}${run.stderr}`,
  );
  const config = JSON.parse(run.stdout);
  return new Set(
    config.files.map((file) => resolve(dirname(tsconfigPath), file)),
  );
}

/**
 * Audit one Vitest project: which type-assertion files under its root are NOT collected as
 * typecheck files (gap 2), and which collected files are NOT root files of the tsconfig Vitest
 * hands to tsc (gap 3).
 */
async function auditProject(project) {
  const root = project.config.root;
  const { typecheckTestFiles } = await project.globTestFiles();
  const collected = new Set(typecheckTestFiles.map((file) => resolve(file)));
  const uncollected = findTypeAssertionFiles(root).filter(
    (file) => !collected.has(file),
  );
  let outsideProgram = [];
  if (collected.size > 0) {
    const tsconfigPath = resolve(
      root,
      project.config.typecheck.tsconfig ?? 'tsconfig.json',
    );
    const programFiles = tsconfigRootFiles(tsconfigPath);
    outsideProgram = [...collected]
      .filter((file) => !programFiles.has(file))
      .sort();
  }
  return { root, collected, uncollected, outsideProgram };
}

function rel(path) {
  return relative(ROOT, path);
}

async function openRootVitest() {
  return createVitest('test', {
    root: ROOT,
    config: ROOT_CONFIG,
    watch: false,
  });
}

let shared;
function sharedVitest() {
  shared ??= openRootVitest();
  return shared;
}
after(async () => {
  if (shared) await (await shared).close();
});

test('root vitest.config.mts delegates to every workspace vitest.config.ts', async () => {
  const vitest = await sharedVitest();
  const projectRoots = vitest.projects
    .map((project) => project.config.root)
    .sort();
  assert.deepEqual(projectRoots, workspaceConfigDirs());
  assert(projectRoots.length > 0, 'no projects resolved');
});

test('every type-assertion file is collected as a typecheck file by its project (gap 2)', async () => {
  const vitest = await sharedVitest();
  const missing = [];
  let checked = 0;
  for (const project of vitest.projects) {
    const audit = await auditProject(project);
    checked += audit.collected.size;
    missing.push(...audit.uncollected.map(rel));
  }
  assert.deepEqual(
    missing,
    [],
    'type assertions that no typecheck.include collects — they can only fail under `npm run lint`. ' +
      'Move them to src/**/*.test-d.ts (or extend that package’s typecheck.include).',
  );
  assert(
    checked > 0,
    'no typecheck files collected at all; the harness is checking nothing',
  );
});

test('every collected typecheck file is a root file of the tsconfig Vitest hands to tsc (gap 3)', async () => {
  const vitest = await sharedVitest();
  const outside = [];
  for (const project of vitest.projects) {
    outside.push(...(await auditProject(project)).outsideProgram.map(rel));
  }
  assert.deepEqual(
    outside,
    [],
    'collected by Vitest’s typecheck glob but outside its tsconfig’s include — reported as passing with zero type analysis',
  );
});

test('sabotage: a known-bad type test FAILS a root-invoked `vitest run <path>` (gap 1)', () => {
  const probe = join(
    ROOT,
    'packages',
    'core',
    'src',
    '__tcprobe_known_bad.test-d.ts',
  );
  writeFileSync(
    probe,
    [
      "import { expectTypeOf, test } from 'vitest';",
      '',
      "test('known-bad probe', () => {",
      '  expectTypeOf<string>().toEqualTypeOf<number>();',
      '});',
      '',
    ].join('\n'),
  );
  try {
    // No `--config`: this is the bare root invocation ENG-648 is about, so it must also prove
    // the root config is discovered. Under Vitest's defaults a `.test-d.ts` matches no runtime
    // include and the run reports "No test files found" instead of a type failure.
    const run = spawnSync(process.execPath, [VITEST, 'run', rel(probe)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const out = run.stdout + run.stderr;
    assert.notEqual(run.status, 0, `known-bad probe passed:\n${out}`);
    assert.match(out, /Type Errors\s+1 failed/, out);
    assert.match(out, /Tests\s+1 failed \(1\)/, out);
    assert.match(
      out,
      /\|@manifest-network\/manifest-mcp-core\| src\/__tcprobe_known_bad\.test-d\.ts > known-bad probe/,
      `probe was not attributed to the core project:\n${out}`,
    );
  } finally {
    rmSync(probe, { force: true });
  }
});

test('wiring: npm, CI, biome, and .gitignore retain the gate', () => {
  const packageJson = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['check:type-tests'],
    'node --test scripts/check-type-tests.test.mjs',
  );
  // CI must run this after the build: sdk/agent-core/fred type tests resolve siblings through dist.
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const gate = ci.search(/^\s*- run: npm run check:type-tests$/m);
  const build = ci.search(/^\s*- run: npm run build$/m);
  assert(gate !== -1, 'ci.yml runs check:type-tests');
  assert(build !== -1 && build < gate, 'ci.yml builds before check:type-tests');
  const biome = JSON.parse(readFileSync(join(ROOT, 'biome.json'), 'utf8'));
  assert(
    biome.files.includes.includes('scripts/check-type-tests.test.mjs'),
    'biome.json includes',
  );
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
  for (const pattern of [
    'packages/*/src/__tcprobe_*.ts',
    'packages/*/src/.__tcprobe_*/',
  ]) {
    assert(gitignore.includes(pattern), `.gitignore lists ${pattern}`);
  }
});

test('sabotage: hasTypeAssertion sees code, not comments or strings', () => {
  assert.equal(
    hasTypeAssertion('expectTypeOf<string>().toEqualTypeOf<string>();'),
    true,
  );
  assert.equal(hasTypeAssertion('assertType<string>(value);'), true);
  assert.equal(
    hasTypeAssertion('// expectTypeOf<string>().toEqualTypeOf<number>();'),
    false,
  );
  assert.equal(
    hasTypeAssertion('/* expectTypeOf<string>() */ const x = 1;'),
    false,
  );
  assert.equal(hasTypeAssertion("const name = 'expectTypeOf';"), false);
  assert.equal(hasTypeAssertion('const name = `assertType`;'), false);
  assert.equal(hasTypeAssertion('const expectTypeOfLike = 1;'), false);
});

test('sabotage: the audit flags an inert runtime-file assertion and a dot-directory type test', async () => {
  const coreSrc = join(ROOT, 'packages', 'core', 'src');
  const inert = join(coreSrc, '__tcprobe_inert.test.ts');
  const dotDir = join(coreSrc, '.__tcprobe_dot');
  const dotProbe = join(dotDir, 'probe.test-d.ts');
  writeFileSync(
    inert,
    "import { expectTypeOf, it } from 'vitest';\nit('inert', () => {\n  expectTypeOf<string>().toEqualTypeOf<number>();\n});\n",
  );
  mkdirSync(dotDir, { recursive: true });
  writeFileSync(
    dotProbe,
    "import { expectTypeOf, it } from 'vitest';\nit('dot', () => {\n  expectTypeOf<string>().toEqualTypeOf<number>();\n});\n",
  );
  // A fresh instance: the shared one has already globbed and caches its file lists.
  const vitest = await openRootVitest();
  try {
    const core = vitest.projects.find(
      (project) => project.config.root === join(ROOT, 'packages', 'core'),
    );
    assert(core, 'core project not resolved');
    const audit = await auditProject(core);
    assert(
      audit.uncollected.includes(inert),
      `gap-2 detector missed the inert probe: ${audit.uncollected.map(rel)}`,
    );
    assert(
      audit.collected.has(dotProbe),
      'Vitest did not collect the dot-directory probe; the gap-3 sabotage proves nothing',
    );
    assert(
      audit.outsideProgram.includes(dotProbe),
      `gap-3 detector missed the dot-directory probe: ${audit.outsideProgram.map(rel)}`,
    );
  } finally {
    await vitest.close();
    rmSync(inert, { force: true });
    rmSync(dotDir, { recursive: true, force: true });
  }
});
