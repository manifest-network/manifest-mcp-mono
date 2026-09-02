#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function collectExportedTypes(value, targets) {
  if (Array.isArray(value)) {
    for (const item of value) collectExportedTypes(item, targets);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [condition, target] of Object.entries(value)) {
    if (condition === 'types' && typeof target === 'string') {
      targets.add(target);
    } else {
      collectExportedTypes(target, targets);
    }
  }
}

function workspaceDirectories(rootDirectory, patterns) {
  return patterns.flatMap((pattern) => {
    if (!pattern.includes('*')) return [resolve(rootDirectory, pattern)];
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const parent = resolve(rootDirectory, pattern.slice(0, -2));
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(parent, entry.name));
  });
}

function repoRelative(rootDirectory, workspaceDirectory, target) {
  const path = relative(rootDirectory, resolve(workspaceDirectory, target));
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`Workspace declaration escapes the repository: ${target}`);
  }
  return path.split(sep).join('/');
}

export function discoverWorkspaceDeclarations(rootDirectory = repoRoot) {
  const rootPackageJson = JSON.parse(
    readFileSync(resolve(rootDirectory, 'package.json'), 'utf8'),
  );
  const patterns = Array.isArray(rootPackageJson.workspaces)
    ? rootPackageJson.workspaces
    : rootPackageJson.workspaces?.packages;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('No npm workspaces configured');
  }

  const declarations = new Set();
  for (const directory of workspaceDirectories(rootDirectory, patterns)) {
    const packageJsonPath = resolve(directory, 'package.json');
    if (!existsSync(packageJsonPath)) continue;

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const targets = new Set();
    if (typeof packageJson.types === 'string') targets.add(packageJson.types);
    collectExportedTypes(packageJson.exports, targets);
    for (const target of targets) {
      declarations.add(repoRelative(rootDirectory, directory, target));
    }
  }

  return [...declarations].sort((a, b) => a.localeCompare(b));
}

function runWorkspaceBuild(rootDirectory) {
  const npmCommand = platform() === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCommand, ['run', 'build'], {
    cwd: rootDirectory,
    shell: platform() === 'win32',
    stdio: 'inherit',
  });
}

export function ensureE2eTypecheckBuild({
  rootDirectory = repoRoot,
  declarationPaths,
  declarationExists = existsSync,
  runBuild = runWorkspaceBuild,
  log = console.log,
} = {}) {
  const requiredDeclarations =
    declarationPaths ?? discoverWorkspaceDeclarations(rootDirectory);
  if (requiredDeclarations.length === 0) {
    throw new Error('No workspace declaration outputs discovered');
  }

  // Always rebuild: existence alone cannot distinguish fresh declarations from
  // stale output left by a scoped or interrupted build.
  log('Building workspace declarations required by the e2e type-check');
  runBuild(rootDirectory);

  const stillMissing = requiredDeclarations.filter(
    (path) => !declarationExists(resolve(rootDirectory, path)),
  );
  if (stillMissing.length > 0) {
    throw new Error(
      `Workspace build did not create: ${stillMissing.join(', ')}`,
    );
  }

  return requiredDeclarations;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  ensureE2eTypecheckBuild();
}
