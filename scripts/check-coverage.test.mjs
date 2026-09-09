import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

for (const scope of ['global', 'queries', 'transactions']) {
  test(`coverage counts never-imported production files and independently enforces the ${scope} floor`, {
    timeout: 90_000,
  }, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'eng805-coverage-'));
    try {
      const sourceRoot = join(fixture, 'packages/core/src');
      const source = scope === 'global' ? sourceRoot : join(sourceRoot, scope);
      mkdirSync(source, { recursive: true });
      symlinkSync(
        join(root, 'node_modules'),
        join(fixture, 'node_modules'),
        'dir',
      );
      writeFileSync(
        join(fixture, 'package.json'),
        JSON.stringify({ private: true, type: 'module' }),
      );
      writeFileSync(
        join(sourceRoot, 'covered.ts'),
        Array.from(
          { length: scope === 'global' ? 1 : 100 },
          (_, index) =>
            `export function covered${index}() { return ${index}; }`,
        ).join('\n'),
      );
      writeFileSync(
        join(source, 'untested.ts'),
        'export function untested() { return 2; }\n',
      );
      writeFileSync(
        join(fixture, 'vitest.config.mjs'),
        `import base from ${JSON.stringify(new URL('../vitest.config.mts', import.meta.url).href)};\n` +
          `export default { test: { include: ['fixture.test.ts'], coverage: base.test.coverage } };\n`,
      );
      const testFile = join(fixture, 'fixture.test.ts');
      writeFileSync(
        testFile,
        `import { expect, test } from 'vitest';\n` +
          `import * as covered from './packages/core/src/covered';\n` +
          `test('covered functions', () => { for (let i = 0; i < ${scope === 'global' ? 1 : 100}; i++) expect(covered['covered' + i]()).toBe(i); });\n`,
      );
      const run = () =>
        spawnSync(
          process.execPath,
          [
            join(root, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--coverage',
            '--maxWorkers=1',
          ],
          {
            cwd: fixture,
            encoding: 'utf8',
            timeout: 40_000,
            env: { ...process.env, NO_COLOR: '1' },
          },
        );
      const failing = run();
      assert.equal(failing.error, undefined);
      assert.notEqual(failing.status, 0, failing.stdout + failing.stderr);
      assert.ok(
        (failing.stdout + failing.stderr).includes(
          scope === 'global'
            ? 'global threshold'
            : `"packages/core/src/${scope}/**" threshold`,
        ),
        `The ${scope} threshold must independently reject its coverage gap`,
      );
      if (scope !== 'global') {
        assert.doesNotMatch(
          failing.stdout + failing.stderr,
          /global threshold/i,
        );
      }
      const report = JSON.parse(
        readFileSync(join(fixture, 'coverage/coverage-summary.json'), 'utf8'),
      );
      const unseen = report[join(source, 'untested.ts')];
      assert.ok(
        unseen,
        'A production file that no test imports must stay in the report',
      );
      assert.ok(unseen.lines.total > 0);
      assert.equal(unseen.lines.covered, 0);
      if (scope !== 'global') {
        for (const metric of ['lines', 'statements', 'branches', 'functions']) {
          assert.ok(
            report.total[metric].pct >= 99,
            `${metric}: unrelated well-covered code must keep the global floor green`,
          );
        }
      }

      writeFileSync(
        testFile,
        readFileSync(testFile, 'utf8') +
          `import { untested } from './packages/core/src/${scope === 'global' ? '' : `${scope}/`}untested';\n` +
          `test('new coverage', () => expect(untested()).toBe(2));\n`,
      );
      const passing = run();
      assert.equal(passing.error, undefined);
      assert.equal(passing.status, 0, passing.stdout + passing.stderr);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
