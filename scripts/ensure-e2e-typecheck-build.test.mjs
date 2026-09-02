import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  discoverWorkspaceDeclarations,
  ensureE2eTypecheckBuild,
  repoRoot,
} from './ensure-e2e-typecheck-build.mjs';

test('sabotage: discovers the complete public workspace declaration set', () => {
  const declarations = discoverWorkspaceDeclarations();
  const expected = [
    'examples/sdk-acceptance/dist/index.d.ts',
    'packages/agent-core/dist/guarded-fetch.d.ts',
    'packages/agent-core/dist/index.d.ts',
    'packages/agent/dist/index.d.ts',
    'packages/chain/dist/index.d.ts',
    'packages/core/dist/__test-utils__/callTool.d.ts',
    'packages/core/dist/__test-utils__/callToolWithElicitation.d.ts',
    'packages/core/dist/__test-utils__/fetch-probe.d.ts',
    'packages/core/dist/__test-utils__/fred-wire.d.ts',
    'packages/core/dist/__test-utils__/mocks.d.ts',
    'packages/core/dist/events-node.d.ts',
    'packages/core/dist/faucet.d.ts',
    'packages/core/dist/gas.d.ts',
    'packages/core/dist/guarded-fetch.d.ts',
    'packages/core/dist/index.d.ts',
    'packages/core/dist/ssrf.d.ts',
    'packages/cosmwasm/dist/index.d.ts',
    'packages/fred/dist/index.d.ts',
    'packages/fred/dist/node.d.ts',
    'packages/fred/dist/server/index.d.ts',
    'packages/lease/dist/index.d.ts',
    'packages/sdk/dist/catalog.d.ts',
    'packages/sdk/dist/chain.d.ts',
    'packages/sdk/dist/deploy.d.ts',
    'packages/sdk/dist/faucet.d.ts',
    'packages/sdk/dist/index.d.ts',
    'packages/sdk/dist/node.d.ts',
    'packages/sdk/dist/orchestration.d.ts',
    'packages/sdk/dist/reads.d.ts',
  ].sort((a, b) => a.localeCompare(b));

  assert.deepEqual(declarations, expected);
  assert(declarations.includes('packages/agent-core/dist/index.d.ts'));
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
  for (const script of ['check', 'check:fix', 'format']) {
    assert.match(packageJson.scripts[script], new RegExp(testPath));
  }

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
