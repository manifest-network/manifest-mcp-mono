#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPackedPackage } from '../tools/package-integrity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = resolve(root, 'packages');
const npm = platform() === 'win32' ? 'npm.cmd' : 'npm';

function publishedPackages() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = resolve(packagesDir, entry.name);
      const packageJsonPath = resolve(directory, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return { directory, packageJson };
    })
    .filter(({ packageJson }) => packageJson.private !== true)
    .sort((a, b) => a.packageJson.name.localeCompare(b.packageJson.name));
}

function packManifest(directory, cache) {
  const output = execFileSync(
    npm,
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_cache: cache,
        NPM_CONFIG_CACHE: cache,
      },
      // npm.cmd is a shell script. Node's CVE-2024-27980 hardening rejects it
      // through execFileSync on Windows unless shell execution is explicit.
      shell: platform() === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const manifests = JSON.parse(output);
  if (!Array.isArray(manifests) || manifests.length !== 1) {
    throw new Error(`expected one npm-pack manifest, received: ${output}`);
  }
  return manifests[0];
}

const failures = [];
const cache = mkdtempSync(join(tmpdir(), 'manifest-mcp-pack-check-'));

try {
  const packages = publishedPackages();
  if (packages.length === 0) throw new Error('no publishable packages found');

  for (const { directory, packageJson } of packages) {
    const manifest = packManifest(directory, cache);
    const result = inspectPackedPackage({
      directory,
      packageJson,
      files: manifest.files,
    });
    failures.push(...result.failures);

    console.log(
      `checked ${packageJson.name}: ${manifest.files.length} packed files, ${result.sources} runtime/declaration sources, ${result.declarations} declarations, ${result.externalReferenceCount} external references`,
    );
  }
} finally {
  rmSync(cache, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('\nPackage integrity check failed:');
  for (const failure of [...new Set(failures)].sort()) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nPackage integrity check passed.');
}
