// Root type-test harness (ENG-648). Run as `npm run check:type-tests`; CI runs it.
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
//
// The harness needs no built dist: its one real Vitest run is a core-only probe, and the
// coverage checks use `tsc --showConfig`, which matches include/exclude without a program.
// Do not run it concurrently with `npm test` or `npm run lint`: its probes are written into
// packages/core/src and would surface in a tsc program built at the same moment.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createVitest } from 'vitest/node';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_CONFIG = join(ROOT, 'vitest.config.mts');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const TS_SOURCE = /\.[cm]?tsx?$/;
const TS_DECLARATION = /\.d\.[cm]?ts$/;
const TYPE_TEST = /\.test-d\.[cm]?tsx?$/;

/** Identifiers whose presence makes a file a type-assertion file. Both are runtime no-ops. */
const TYPE_ASSERTION_IDENTIFIERS = new Set(['expectTypeOf', 'assertType']);

// Probe locations. Every one is gitignored (the wiring test proves it with `git check-ignore`):
// a killed run leaves them behind, and a leftover must fail the next core typecheck loudly by
// name rather than ever be committable. A trailing slash marks the directory probes, which is
// how both .gitignore and `git check-ignore` distinguish a directory pattern.
const CORE_SRC = join(ROOT, 'packages', 'core', 'src');
const PROBES = {
  knownBad: join(CORE_SRC, '__tcprobe_known_bad.test-d.ts'),
  inert: join(CORE_SRC, '__tcprobe_inert.test.ts'),
  dotDir: `${join(CORE_SRC, '.__tcprobe_dot')}/`,
  nestedWorktree: `${join(ROOT, '.claude', 'worktrees', '__tcprobe_nested')}/`,
};

const KNOWN_BAD_SOURCE = [
  "import { expectTypeOf, test } from 'vitest';",
  '',
  "test('known-bad probe', () => {",
  '  expectTypeOf<string>().toEqualTypeOf<number>();',
  '});',
  '',
].join('\n');

/**
 * True when the source uses a type-assertion identifier in CODE. Parsed with TypeScript so an
 * `expectTypeOf` inside a comment, a string, a template or a regex literal does not count — a
 * plain grep would pass on a commented-out assertion, which is its own kind of vacuous. An
 * aliased import (`{ expectTypeOf as e }`) still counts: the import specifier is an identifier.
 */
function hasTypeAssertion(source, fileName = 'probe.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && TYPE_ASSERTION_IDENTIFIERS.has(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Every file under `dir` that must be type-checked as a test: any `*.test-d.ts` (a type test by
 * name — one that no glob collects never runs at all), plus any TypeScript source whose code
 * carries a type assertion. Dot-directories are walked on purpose: Vitest collects from them
 * and tsc does not, which is gap 3.
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
      !TS_SOURCE.test(entry.name) ||
      TS_DECLARATION.test(entry.name)
    ) {
      continue;
    }
    if (
      TYPE_TEST.test(entry.name) ||
      hasTypeAssertion(readFileSync(path, 'utf8'), entry.name)
    ) {
      hits.push(path);
    }
  }
  return hits.sort();
}

/** Workspace groups from package.json (`packages/*` -> `packages`): the one list npm itself uses. */
function workspaceGroups() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return pkg.workspaces.map((glob) => {
    assert.match(glob, /^[^*]+\/\*$/, `workspace glob ${glob} is not <dir>/*`);
    return glob.slice(0, -2);
  });
}

/** Every workspace member directory, whether or not it has a vitest.config.ts. */
function workspaceDirs() {
  const dirs = [];
  for (const group of workspaceGroups()) {
    for (const entry of readdirSync(join(ROOT, group), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) dirs.push(join(ROOT, group, entry.name));
    }
  }
  return dirs.sort();
}

/** Root files of the tsconfig program, as absolute paths. `--showConfig` matches include/exclude without building the program. */
function tsconfigRootFiles(tsconfigPath) {
  const run = spawnSync(
    process.execPath,
    [TSC, '--showConfig', '-p', tsconfigPath],
    { cwd: ROOT, encoding: 'utf8' },
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

/** Typecheck files collected by one project, as absolute paths. */
async function collectedBy(project) {
  const { typecheckTestFiles } = await project.globTestFiles();
  return new Set(typecheckTestFiles.map((file) => resolve(file)));
}

/** Typecheck files collected by ANY project. */
async function collectedByAny(vitest) {
  const all = new Set();
  for (const project of vitest.projects) {
    for (const file of await collectedBy(project)) all.add(file);
  }
  return all;
}

/**
 * Gap 3 for one project: collected typecheck files that are NOT root files of the tsconfig
 * Vitest hands to tsc. Reported as passing with zero type analysis if they exist.
 */
async function outsideProgram(project) {
  const collected = await collectedBy(project);
  if (collected.size === 0) return [];
  const tsconfigPath = resolve(
    project.config.root,
    project.config.typecheck.tsconfig ?? 'tsconfig.json',
  );
  const programFiles = tsconfigRootFiles(tsconfigPath);
  return [...collected].filter((file) => !programFiles.has(file)).sort();
}

function rel(path) {
  return relative(ROOT, path);
}

function isIgnored(path) {
  return (
    spawnSync('git', ['check-ignore', '-q', path], { cwd: ROOT }).status === 0
  );
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

test('root vitest.config.mts delegates to every workspace member', async () => {
  const vitest = await sharedVitest();
  const groups = workspaceGroups();
  assert.deepEqual(
    vitest.config.projects,
    groups.map((group) => `${group}/*/vitest.config.ts`),
    'the root projects list must be exactly the package.json workspace groups',
  );
  const projectRoots = vitest.projects
    .map((project) => project.config.root)
    .sort();
  assert.deepEqual(
    projectRoots,
    workspaceDirs(),
    'every workspace member must resolve as a project — a member without a vitest.config.ts runs under Vitest defaults (no typecheck, no fetch ban)',
  );
  assert(projectRoots.length > 0, 'no projects resolved');
});

test('gap 2: every type-assertion file in every workspace member is collected as a typecheck file', async () => {
  const vitest = await sharedVitest();
  const collected = await collectedByAny(vitest);
  const missing = workspaceDirs()
    .flatMap((dir) => findTypeAssertionFiles(dir))
    .filter((file) => !collected.has(file))
    .map(rel);
  assert.deepEqual(
    missing,
    [],
    'type assertions that no typecheck.include collects — they can only fail under `npm run lint`. ' +
      'Move them to src/**/*.test-d.ts (or extend that package’s typecheck.include).',
  );
  assert(
    collected.size > 0,
    'no typecheck files collected at all; the harness is checking nothing',
  );
});

test('gap 3: every collected typecheck file is a root file of the tsconfig Vitest hands to tsc', async () => {
  const vitest = await sharedVitest();
  const outside = [];
  for (const project of vitest.projects) {
    outside.push(...(await outsideProgram(project)).map(rel));
  }
  assert.deepEqual(
    outside,
    [],
    'collected by Vitest’s typecheck glob but outside its tsconfig’s include — reported as passing with zero type analysis',
  );
});

test('gap 1 (sabotage): a known-bad type test FAILS a root-invoked `vitest run <path>`', () => {
  writeFileSync(PROBES.knownBad, KNOWN_BAD_SOURCE);
  try {
    // No `--config`: this is the bare root invocation ENG-648 is about, so it must also prove
    // the root config is discovered. Under Vitest's defaults a `.test-d.ts` matches no runtime
    // include and the run reports "No test files found" instead of a type failure.
    const run = spawnSync(
      process.execPath,
      [VITEST, 'run', rel(PROBES.knownBad)],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      },
    );
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
    rmSync(PROBES.knownBad, { force: true });
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
  // Ordered after the build: today's probe is core-only and needs no dist, but a future
  // cross-package probe would, and that dependency must not become load-bearing by accident.
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
  for (const [name, probe] of Object.entries(PROBES)) {
    assert(isIgnored(probe), `${name} probe ${rel(probe)} must be gitignored`);
  }
});

test('sabotage: hasTypeAssertion sees code, not comments or strings', () => {
  assert.equal(
    hasTypeAssertion('expectTypeOf<string>().toEqualTypeOf<string>();'),
    true,
  );
  assert.equal(hasTypeAssertion('assertType<string>(value);'), true);
  assert.equal(
    hasTypeAssertion(
      "import { expectTypeOf as e } from 'vitest';\ne<string>();",
    ),
    true,
  );
  assert.equal(
    hasTypeAssertion('const r = /[/*]/;\nexpectTypeOf<string>();'),
    true,
    'a regex literal must not derail the parse',
  );
  assert.equal(
    hasTypeAssertion('const el = <div />;\nexpectTypeOf<string>();', 'a.tsx'),
    true,
  );
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
  assert.equal(hasTypeAssertion('const re = /expectTypeOf/;'), false);
  assert.equal(hasTypeAssertion('const expectTypeOfLike = 1;'), false);
});

test('sabotage: findTypeAssertionFiles finds every TypeScript flavour and skips declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tcprobe-'));
  try {
    const assertion = 'expectTypeOf<string>().toEqualTypeOf<string>();\n';
    for (const name of [
      'a.test.ts',
      'b.test.mts',
      'c.test.cts',
      'd.test.tsx',
    ]) {
      writeFileSync(join(dir, name), assertion);
    }
    writeFileSync(join(dir, 'e.test-d.ts'), 'export {};\n');
    writeFileSync(join(dir, 'f.d.ts'), assertion);
    writeFileSync(join(dir, 'g.ts'), "export const x = 'expectTypeOf';\n");
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, '.hidden', 'h.test-d.ts'), 'export {};\n');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'i.test-d.ts'), 'export {};\n');
    assert.deepEqual(
      findTypeAssertionFiles(dir).map((file) => relative(dir, file)),
      [
        '.hidden/h.test-d.ts',
        'a.test.ts',
        'b.test.mts',
        'c.test.cts',
        'd.test.tsx',
        'e.test-d.ts',
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sabotage: the detectors flag an inert runtime-file assertion, a dot-directory type test, and ignore a nested worktree', async () => {
  const inert = PROBES.inert;
  const dotProbe = join(PROBES.dotDir, 'probe.test-d.ts');
  // The review's exact repro: a nested checkout under .claude/worktrees carrying a copy of a
  // package's vitest.config.ts and a known-bad type test with a REAL file's name.
  const nestedCore = join(PROBES.nestedWorktree, 'packages', 'core');
  const nestedProbe = join(nestedCore, 'src', 'manifest-types.test-d.ts');
  writeFileSync(
    inert,
    "import { expectTypeOf, it } from 'vitest';\nit('inert', () => {\n  expectTypeOf<string>().toEqualTypeOf<number>();\n});\n",
  );
  mkdirSync(PROBES.dotDir, { recursive: true });
  writeFileSync(dotProbe, KNOWN_BAD_SOURCE);
  mkdirSync(join(nestedCore, 'src'), { recursive: true });
  cpSync(
    join(ROOT, 'packages', 'core', 'vitest.config.ts'),
    join(nestedCore, 'vitest.config.ts'),
  );
  writeFileSync(nestedProbe, KNOWN_BAD_SOURCE);
  // A fresh instance: the shared one has already globbed and caches its file lists.
  const vitest = await openRootVitest();
  try {
    const collected = await collectedByAny(vitest);
    assert(
      findTypeAssertionFiles(join(ROOT, 'packages', 'core')).includes(inert) &&
        !collected.has(inert),
      'gap-2 detector missed the inert probe',
    );
    const core = vitest.projects.find(
      (project) => project.config.root === join(ROOT, 'packages', 'core'),
    );
    assert(core, 'core project not resolved');
    assert(
      collected.has(dotProbe),
      'Vitest did not collect the dot-directory probe; the gap-3 sabotage proves nothing',
    );
    assert(
      (await outsideProgram(core)).includes(dotProbe),
      'gap-3 detector missed the dot-directory probe',
    );
    assert(
      vitest.projects.every(
        (project) => !project.config.root.startsWith(join(ROOT, '.claude')),
      ),
      'a nested worktree resolved as a project',
    );
    const filter = 'packages/core/src/manifest-types.test-d.ts';
    const matches = [];
    for (const project of vitest.projects) {
      const { testFiles, typecheckTestFiles } = await project.globTestFiles([
        filter,
      ]);
      matches.push(...testFiles, ...typecheckTestFiles);
    }
    assert.deepEqual(
      matches.map(rel),
      [filter],
      'the review filter must match exactly the real core file, never the nested copy',
    );
  } finally {
    await vitest.close();
    rmSync(inert, { force: true });
    rmSync(PROBES.dotDir, { recursive: true, force: true });
    rmSync(PROBES.nestedWorktree, { recursive: true, force: true });
  }
});
