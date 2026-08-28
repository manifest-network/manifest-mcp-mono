#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = resolve(root, 'packages');
const npm = platform() === 'win32' ? 'npm.cmd' : 'npm';
const declarationDependencyPackages = new Set([
  '@manifest-network/manifest-sdk',
]);

const builtinSpecifiers = new Set(
  builtinModules.flatMap((specifier) => [
    specifier,
    specifier.startsWith('node:') ? specifier.slice(5) : `node:${specifier}`,
  ]),
);

function packageNameFromSpecifier(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    builtinSpecifiers.has(specifier)
  ) {
    return undefined;
  }

  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function declarationImports(filepath) {
  const source = ts.createSourceFile(
    filepath,
    readFileSync(filepath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = new Set();

  function addStringLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) imports.add(node.text);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addStringLiteral(node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      addStringLiteral(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return imports;
}

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
const uncheckedDeclarationPackages = new Set(declarationDependencyPackages);

try {
  const packages = publishedPackages();
  if (packages.length === 0) throw new Error('no publishable packages found');

  for (const { directory, packageJson } of packages) {
    const manifest = packManifest(directory, cache);
    const files = manifest.files.map(({ path }) => path);
    const declarations = files.filter((path) => path.endsWith('.d.ts'));

    if (!files.some((path) => path.startsWith('dist/'))) {
      failures.push(
        `${packageJson.name}: npm pack contains no dist/ files; run the build first`,
      );
    }

    for (const path of files) {
      // Declaration bundlers may materialize external .d.ts files under this path
      // (fred currently does this for manifestjs). Runtime code there is always a
      // packaging defect: npm will ship a private dependency tree inside dist.
      if (
        path.startsWith('dist/node_modules/') &&
        !path.endsWith('.d.ts') &&
        !path.endsWith('.d.ts.map')
      ) {
        failures.push(`${packageJson.name}: publishes nested dependency ${path}`);
      }
      if (/\.test-d\.(?:d\.ts|d\.ts\.map|js|js\.map)$/.test(path)) {
        failures.push(`${packageJson.name}: publishes type-test artifact ${path}`);
      }
    }

    // ENG-667 scopes this declaration-import contract to the public SDK. Other
    // packages have intentionally published test-helper declarations that need
    // separate dependency-policy decisions before this can safely expand.
    if (declarationDependencyPackages.has(packageJson.name)) {
      uncheckedDeclarationPackages.delete(packageJson.name);
      const declared = new Set([
        ...Object.keys(packageJson.dependencies ?? {}),
        ...Object.keys(packageJson.optionalDependencies ?? {}),
        ...Object.keys(packageJson.peerDependencies ?? {}),
      ]);
      let externalImportCount = 0;

      for (const path of declarations) {
        for (const specifier of declarationImports(resolve(directory, path))) {
          const dependency = packageNameFromSpecifier(specifier);
          if (dependency) externalImportCount += 1;
          if (
            dependency &&
            dependency !== packageJson.name &&
            !declared.has(dependency)
          ) {
            failures.push(
              `${packageJson.name}: ${path} imports undeclared dependency ${dependency}`,
            );
          }
        }
      }

      if (externalImportCount === 0) {
        failures.push(
          `${packageJson.name}: no external declaration imports found; dependency gate is vacuous`,
        );
      }
    }

    console.log(
      `checked ${packageJson.name}: ${files.length} packed files, ${declarations.length} declarations`,
    );
  }

  for (const packageName of uncheckedDeclarationPackages) {
    failures.push(
      `${packageName}: configured for declaration checking but package was not found`,
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
