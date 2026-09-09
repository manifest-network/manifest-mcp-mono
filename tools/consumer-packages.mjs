import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const npm = platform() === 'win32' ? 'npm.cmd' : 'npm';

export function runNpm(args, cwd, cache) {
  const env = {
    ...process.env,
    npm_config_cache: cache,
    NPM_CONFIG_CACHE: cache,
  };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const result = spawnSync(npm, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    shell: platform() === 'win32',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`npm terminated by ${result.signal}`);
  return result;
}

export function requireSuccess(result, operation) {
  assert.equal(
    result.status,
    0,
    `${operation}\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

/** Include runtime and required peer siblings, never workspace development dependencies. */
export function runtimeClosure(target, packages) {
  const selected = new Map();
  function visit(name) {
    if (selected.has(name)) return;
    const entry = packages.get(name);
    assert.ok(entry, `No packed workspace package for ${name}`);
    selected.set(name, entry);
    const { packageJson } = entry;
    const runtime = {
      ...packageJson.dependencies,
      ...packageJson.optionalDependencies,
      ...Object.fromEntries(
        Object.entries(packageJson.peerDependencies ?? {}).filter(
          ([peer]) => !packageJson.peerDependenciesMeta?.[peer]?.optional,
        ),
      ),
    };
    for (const dependency of Object.keys(runtime)) {
      if (packages.has(dependency)) visit(dependency);
    }
  }
  visit(target);
  return selected;
}

export function packPackage(directory, destination, cache) {
  const output = requireSuccess(
    runNpm(
      ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
      directory,
      cache,
    ),
    `Pack ${directory}`,
  );
  const manifests = JSON.parse(output);
  assert.equal(manifests.length, 1, 'Expected exactly one npm tarball');
  const manifest = manifests[0];
  assert.ok(manifest.integrity, 'npm pack omitted tarball integrity');
  return { ...manifest, tarball: join(destination, manifest.filename) };
}

/** Sibling tarballs stand in for this release before it exists on npm. External edges are untouched. */
export function writeConsumer(directory, selected) {
  mkdirSync(directory, { recursive: true });
  const manifest = {
    name: 'manifest-packed-consumer-check',
    version: '1.0.0',
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(
      [...selected].map(([name, entry]) => [
        name,
        `file:${entry.pack.tarball}`,
      ]),
    ),
  };
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export function installConsumer(directory, cache) {
  return runNpm(
    [
      'install',
      '--ignore-scripts',
      '--workspaces=false',
      '--omit=dev',
      '--include=optional',
      '--include=peer',
      '--audit=false',
      '--fund=false',
      '--install-strategy=hoisted',
    ],
    directory,
    cache,
  );
}

/** Reject registry fallbacks, workspace links and duplicate identity-bearing sibling packages. */
export function verifyInstalledTarballs(directory, selected) {
  const lock = JSON.parse(
    readFileSync(join(directory, 'package-lock.json'), 'utf8'),
  );
  assert.equal(lock.lockfileVersion, 3, 'Expected npm lockfile v3');
  for (const [name, entry] of selected) {
    const location = `node_modules/${name}`;
    const installed = lock.packages?.[location];
    assert.ok(installed, `Missing installed tarball: ${name}`);
    assert.equal(
      installed.link,
      undefined,
      `Workspace link leaked into consumer: ${name}`,
    );
    assert.equal(
      installed.version,
      entry.packageJson.version,
      `Wrong release: ${name}`,
    );
    assert.equal(
      installed.integrity,
      entry.pack.integrity,
      `Not the freshly packed tarball: ${name}`,
    );
    const copies = Object.keys(lock.packages).filter(
      (key) => key === location || key.endsWith(`/${location}`),
    );
    assert.deepEqual(
      copies,
      [location],
      `Duplicate workspace identity: ${name}`,
    );
  }
  return lock;
}

/** Do not turn network/registry errors or malformed reports into a passing audit. */
export function auditResult(result) {
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.error,
    undefined,
    `npm audit failed: ${JSON.stringify(report.error)}`,
  );
  const counts = report.metadata?.vulnerabilities;
  assert.ok(counts, 'npm audit did not return vulnerability counts');
  for (const severity of [
    'info',
    'low',
    'moderate',
    'high',
    'critical',
    'total',
  ]) {
    assert.ok(
      Number.isSafeInteger(counts[severity]) && counts[severity] >= 0,
      `Invalid npm audit ${severity} count`,
    );
  }
  const passes =
    result.status === 0 && counts.high === 0 && counts.critical === 0;
  return { report, passes, counts };
}
