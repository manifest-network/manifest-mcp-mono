import assert from 'node:assert/strict';
import { relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { inspectPackedPackage } from '../tools/package-integrity.mjs';

const directory = resolve('package-integrity-fixture');

function inspect(files, sources = {}, dependencies = {}) {
  return inspectPackedPackage({
    directory,
    packageJson: {
      name: '@example/package',
      dependencies,
    },
    files,
    readSource(filepath) {
      const path = relative(directory, filepath).split(sep).join('/');
      return sources[path] ?? '';
    },
  }).failures;
}

test('sabotage: rejects a nested runtime dependency', () => {
  const path = 'dist/node_modules/private-dep/index.js';
  assert.deepEqual(inspect([path]), [
    `@example/package: publishes nested dependency ${path}`,
  ]);
});

test('sabotage: rejects ordinary and type-test artifacts', () => {
  const failures = inspect([
    'dist/index.js',
    'dist/unit.test.js',
    'dist/types.test.d.ts',
    'dist/contracts.test-d.d.ts',
  ]);
  assert(failures.some((failure) => failure.includes('unit.test.js')));
  assert(failures.some((failure) => failure.includes('types.test.d.ts')));
  assert(failures.some((failure) => failure.includes('contracts.test-d.d.ts')));
});

test('sabotage: rejects undeclared dependencies in runtime JavaScript', () => {
  const path = 'dist/index.js';
  assert.deepEqual(
    inspect([path], { [path]: "import value from 'runtime-only';\n" }),
    [
      '@example/package: dist/index.js imports undeclared dependency runtime-only',
    ],
  );
});

test('sabotage: declarations cover require() and triple-slash type references', () => {
  const path = 'dist/index.d.ts';
  const source = [
    '/// <reference types="missing-types" />',
    "import Required = require('required-types');",
    'export type Value = Required.Value;',
  ].join('\n');
  const failures = inspect([path], { [path]: source });
  assert(
    failures.some((failure) => failure.endsWith('missing-types')),
    failures.join('\n'),
  );
  assert(
    failures.some((failure) => failure.endsWith('required-types')),
    failures.join('\n'),
  );
});
