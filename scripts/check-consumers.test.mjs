import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  auditResult,
  installConsumer,
  packPackage,
  requireSuccess,
  runtimeClosure,
  verifyInstalledTarballs,
  writeConsumer,
} from '../tools/consumer-packages.mjs';

test('consumer command rejects workspace output before npm can inherit repository modules', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./check-consumers.mjs', import.meta.url)),
      '--output',
      fileURLToPath(new URL('../', import.meta.url)),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output must be outside the workspace/);
});

test('runtime closure includes required peers and optional runtime dependencies, excludes development tools', () => {
  const packages = new Map([
    [
      'app',
      {
        packageJson: {
          dependencies: { core: '1.0.0', external: '1.0.0' },
          optionalDependencies: { optional: '1.0.0' },
          devDependencies: { dev: '1.0.0' },
          peerDependencies: { peer: '^1.0.0', dev: '^1.0.0' },
          peerDependenciesMeta: { dev: { optional: true } },
        },
      },
    ],
    ['core', { packageJson: { dependencies: { app: '1.0.0' } } }],
    ...['optional', 'peer', 'dev'].map((name) => [name, { packageJson: {} }]),
  ]);
  assert.deepEqual(
    [...runtimeClosure('app', packages).keys()],
    ['app', 'core', 'optional', 'peer'],
  );
});

test('real packed consumer resolves the unpatched dependency despite repository and library overrides', {
  timeout: 60_000,
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'eng805-consumer-test-'));
  try {
    const repository = join(fixture, 'repository');
    const tarballs = join(fixture, 'tarballs');
    const cache = join(fixture, 'npm-cache');
    mkdirSync(repository);
    mkdirSync(tarballs);
    function pack(name, version, extra = {}, code = '') {
      const directory = join(repository, `${name}-${version}`);
      mkdirSync(directory);
      const packageJson = {
        name,
        version,
        type: 'module',
        main: 'index.js',
        ...extra,
      };
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify(packageJson),
      );
      writeFileSync(join(directory, 'index.js'), code);
      return { packageJson, pack: packPackage(directory, tarballs, cache) };
    }
    const legacy = pack(
      'eng805-fixture-legacy',
      '1.0.0',
      {},
      'export const version = 1;',
    );
    const patched = pack(
      'eng805-fixture-legacy',
      '2.0.0',
      {},
      'export const version = 2;',
    );
    const overrides = {
      'eng805-fixture-legacy': `file:${patched.pack.tarball}`,
    };
    writeFileSync(
      join(repository, 'package.json'),
      JSON.stringify({ private: true, overrides }),
    );
    const core = pack(
      'eng805-fixture-core',
      '1.0.0',
      {
        dependencies: {
          'eng805-fixture-legacy': `file:${legacy.pack.tarball}`,
        },
      },
      "export { version } from 'eng805-fixture-legacy';",
    );
    const app = pack(
      'eng805-fixture-app',
      '1.0.0',
      {
        dependencies: { 'eng805-fixture-core': '1.0.0' },
        overrides,
      },
      "export { version } from 'eng805-fixture-core';",
    );
    const selected = new Map([
      [app.packageJson.name, app],
      [core.packageJson.name, core],
    ]);
    const consumer = join(fixture, 'consumer');
    const manifest = writeConsumer(consumer, selected);
    assert.equal(manifest.overrides, undefined);
    assert.equal(manifest.workspaces, undefined);
    assert.equal(manifest.devDependencies, undefined);
    requireSuccess(
      installConsumer(consumer, cache),
      'Install offline fixture tarballs',
    );
    const lock = verifyInstalledTarballs(consumer, selected);
    assert.equal(
      lock.packages['node_modules/eng805-fixture-legacy'].version,
      '1.0.0',
    );
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import assert from 'node:assert/strict'; import { version } from 'eng805-fixture-app'; assert.equal(version, 1);",
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    requireSuccess(result, 'Read the real unpatched transitive runtime');

    const lockPath = join(consumer, 'package-lock.json');
    const original = readFileSync(lockPath, 'utf8');
    for (const sabotage of [
      (entries) => {
        entries['node_modules/eng805-fixture-core'].link = true;
      },
      (entries) => {
        entries['node_modules/eng805-fixture-core'].integrity =
          'sha512-registry-fallback';
      },
      (entries) => {
        entries[
          'node_modules/eng805-fixture-app/node_modules/eng805-fixture-core'
        ] = entries['node_modules/eng805-fixture-core'];
      },
    ]) {
      const modified = JSON.parse(original);
      sabotage(modified.packages);
      writeFileSync(lockPath, JSON.stringify(modified));
      assert.throws(() => verifyInstalledTarballs(consumer, selected));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('audit fails on high/critical findings, registry errors and malformed reports', () => {
  const clean = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0,
  };
  const result = (counts, status = 0) => ({
    status,
    stdout: JSON.stringify({ metadata: { vulnerabilities: counts } }),
  });
  assert.equal(auditResult(result(clean)).passes, true);
  assert.equal(
    auditResult(result({ ...clean, low: 1, total: 1 })).passes,
    true,
  );
  for (const severity of ['high', 'critical']) {
    for (const status of [0, 1]) {
      assert.equal(
        auditResult(result({ ...clean, [severity]: 1, total: 1 }, status))
          .passes,
        false,
      );
    }
  }
  assert.equal(auditResult(result(clean, 1)).passes, false);
  assert.throws(() =>
    auditResult({ status: 1, stdout: '{"error":{"code":"ENETUNREACH"}}' }),
  );
  assert.throws(() => auditResult({ status: 0, stdout: '{}' }));
  assert.throws(() => auditResult(result({ ...clean, high: '0' })));
  assert.throws(() => auditResult({ status: 0, stdout: 'not JSON' }));
});
