import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  discoverWorkspaceDeclarations,
  ensureE2eTypecheckBuild,
  repoRoot,
} from './ensure-e2e-typecheck-build.mjs';

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('sabotage: discovers top-level and exported workspace declarations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-typecheck-build-'));
  try {
    writeJson(resolve(directory, 'package.json'), {
      workspaces: ['packages/*', 'examples/*'],
    });
    writeJson(resolve(directory, 'packages', 'sdk', 'package.json'), {
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
        },
        './orchestration': {
          types: './dist/orchestration.d.ts',
          import: './dist/orchestration.js',
        },
      },
    });
    writeJson(resolve(directory, 'packages', 'agent-core', 'package.json'), {
      types: 'dist/index.d.ts',
    });
    writeJson(resolve(directory, 'packages', 'bin-only', 'package.json'), {
      bin: { example: './dist/example.js' },
    });
    writeJson(
      resolve(directory, 'examples', 'sdk-acceptance', 'package.json'),
      { types: './dist/index.d.ts' },
    );

    assert.deepEqual(discoverWorkspaceDeclarations(directory), [
      'examples/sdk-acceptance/dist/index.d.ts',
      'packages/agent-core/dist/index.d.ts',
      'packages/sdk/dist/index.d.ts',
      'packages/sdk/dist/orchestration.d.ts',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('sabotage: current closure retains the transitive agent-core output', () => {
  const declarations = discoverWorkspaceDeclarations();
  for (const path of [
    'packages/sdk/dist/orchestration.d.ts',
    'packages/agent-core/dist/index.d.ts',
  ]) {
    assert(declarations.includes(path), `missing declaration guard: ${path}`);
  }
});

test('sabotage: rebuilds even when declarations already exist', () => {
  let buildCount = 0;
  const declarations = ensureE2eTypecheckBuild({
    declarationPaths: ['packages/core/dist/index.d.ts'],
    declarationExists: () => true,
    runBuild: () => {
      buildCount += 1;
    },
    log: () => {},
  });

  assert.equal(buildCount, 1);
  assert.deepEqual(declarations, ['packages/core/dist/index.d.ts']);
});

test('sabotage: rejects a partial declaration closure after building', () => {
  assert.throws(
    () =>
      ensureE2eTypecheckBuild({
        declarationPaths: [
          'packages/sdk/dist/orchestration.d.ts',
          'packages/agent-core/dist/index.d.ts',
        ],
        declarationExists: (path) => !path.includes('/agent-core/'),
        runBuild: () => {},
        log: () => {},
      }),
    /Workspace build did not create: packages\/agent-core\/dist\/index\.d\.ts/,
  );
});

test('sabotage: rejects a vacuous declaration check before building', () => {
  let built = false;
  assert.throws(
    () =>
      ensureE2eTypecheckBuild({
        declarationPaths: [],
        runBuild: () => {
          built = true;
        },
        log: () => {},
      }),
    /No workspace declaration outputs discovered/,
  );
  assert.equal(built, false);
});

test('wiring: npm, CI, release, formatting, and PR checks retain the gate', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
  );
  const testPath = 'scripts/ensure-e2e-typecheck-build.test.mjs';
  assert.equal(
    packageJson.scripts['prelint:e2e'],
    `node --test ${testPath} && node scripts/ensure-e2e-typecheck-build.mjs`,
  );
  assert.equal(packageJson.scripts['lint:e2e'], 'tsc -p e2e/tsconfig.json');
  // Biome's file set is `biome.json`'s `files.includes` (the scripts run `biome check .`), so
  // that list is where this file must be named to stay formatted and linted.
  const biomeConfig = JSON.parse(
    readFileSync(resolve(repoRoot, 'biome.json'), 'utf8'),
  );
  assert(biomeConfig.files.includes.includes(testPath), 'biome.json includes');
  assert.equal(packageJson.scripts.check, 'biome check .');
  assert.equal(packageJson.scripts['check:fix'], 'biome check --write .');
  assert.equal(packageJson.scripts.format, 'biome format --write .');

  for (const workflow of ['ci.yml', 'release.yml']) {
    const source = readFileSync(
      resolve(repoRoot, '.github', 'workflows', workflow),
      'utf8',
    );
    assert.match(source, /^\s*- run: npm run lint:e2e$/m, workflow);
  }

  const pullRequestTemplate = readFileSync(
    resolve(repoRoot, '.github', 'pull_request_template.md'),
    'utf8',
  );
  assert.match(pullRequestTemplate, /`npm run lint:e2e` passes/);
});
