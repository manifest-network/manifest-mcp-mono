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

test('sabotage: rejects a package with no recognized shipped sources', () => {
  assert.deepEqual(inspect(['dist/index.json']), [
    '@example/package: no shipped JS/declaration sources found; dependency gate is vacuous',
  ]);
});

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

test('sabotage: rejects declarations that implicitly export private names', () => {
  // rolldown-plugin-dts 0.28 (tsdown 0.23) emitted core's faucet.d.ts in this
  // shape: inline exports, a private schema, and no export statement.
  const path = 'dist/faucet.d.ts';
  const source = [
    "import { z } from 'zod';",
    'declare const FaucetAccountSchema: z.ZodObject<{}>;',
    'export type FaucetAccount = z.infer<typeof FaucetAccountSchema>;',
    'export declare function requestFaucet(): Promise<void>;',
  ].join('\n');
  assert.deepEqual(inspect([path], { [path]: source }, { zod: '^4.3.6' }), [
    '@example/package: dist/faucet.d.ts has no export statement, so TypeScript exposes private declarations FaucetAccountSchema',
  ]);
});

test('sabotage: reports every kind of implicitly exported declaration', () => {
  const path = 'dist/kinds.d.ts';
  const source = [
    'declare const first: number, second: string;',
    'declare function run(): void;',
    'declare class Runner {}',
    'interface Shape {}',
    'type Alias = Shape;',
    'declare enum Mode { A }',
    'declare namespace Space {}',
    'export declare const visible: number;',
  ].join('\n');
  assert.deepEqual(inspect([path], { [path]: source }), [
    '@example/package: dist/kinds.d.ts has no export statement, so TypeScript exposes private declarations first, second, run, Runner, Shape, Alias, Mode, Space',
  ]);
});

test('sabotage: an exported default declaration is not an export statement', () => {
  // `export default function` is a declaration with modifiers, not an export
  // declaration or assignment, so TypeScript still exports `priv`.
  const path = 'dist/default.d.ts';
  const source = [
    'export default function run(): void;',
    'declare const priv: number;',
    'declare function overloaded(): void;',
    'declare function overloaded(value: number): void;',
  ].join('\n');
  assert.deepEqual(inspect([path], { [path]: source }), [
    '@example/package: dist/default.d.ts has no export statement, so TypeScript exposes private declarations priv, overloaded',
  ]);
});

test('accepts private declarations behind an explicit export statement', () => {
  const path = 'dist/index.d.ts';
  for (const statement of [
    'export { Value };',
    'export type { Value };',
    'export {};',
    'export = Schema;',
    'export default Schema;',
    "export * from './other.js';",
    "export * as ns from './other.js';",
  ]) {
    const source = [
      'declare const Schema: number;',
      'type Value = typeof Schema;',
      statement,
    ].join('\n');
    assert.deepEqual(inspect([path], { [path]: source }), [], statement);
  }
});

test('accepts inline-only exports, imports, and scope augmentations', () => {
  const path = 'dist/index.d.ts';
  const source = [
    "import { z } from 'zod';",
    "import Legacy = require('legacy');",
    'export declare const schema: z.ZodString;',
    'export interface Shape { value: Legacy.Value }',
    "declare module 'other' { interface Extra { value: number } }",
    'declare global { interface Window { value: number } }',
  ].join('\n');
  assert.deepEqual(
    inspect(
      [path],
      { [path]: source },
      { zod: '^4.3.6', legacy: '1.0.0', other: '1.0.0' },
    ),
    [],
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
