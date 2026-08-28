import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';

const BUILTIN_SPECIFIERS = new Set(
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
    BUILTIN_SPECIFIERS.has(specifier)
  ) {
    return undefined;
  }

  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * TypeScript's preprocessor covers ESM imports/exports, import types,
 * require(), and triple-slash type references without building a full AST.
 */
export function dependencySpecifiers(source) {
  const info = ts.preProcessFile(source, true, true);
  // `libReferenceDirectives` name compiler-provided standard libraries (for
  // example `dom`), not packages a consumer must install.
  return new Set([
    ...info.importedFiles.map(({ fileName }) => fileName),
    ...info.typeReferenceDirectives.map(({ fileName }) => fileName),
  ]);
}

function isShippedSource(path) {
  return /(?:\.d\.[cm]?ts|\.[cm]?js)$/.test(path);
}

/** Inspect one npm-pack manifest. Kept pure enough for sabotage tests. */
export function inspectPackedPackage({
  directory,
  packageJson,
  files: manifestFiles,
  readSource = (filepath) => readFileSync(filepath, 'utf8'),
}) {
  const failures = [];
  const files = manifestFiles.map((file) =>
    typeof file === 'string' ? file : file.path,
  );
  const sourceFiles = files.filter(isShippedSource);
  const declarations = files.filter((path) => /\.d\.[cm]?ts$/.test(path));

  if (!files.some((path) => path.startsWith('dist/'))) {
    failures.push(
      `${packageJson.name}: npm pack contains no dist/ files; run the build first`,
    );
  }

  for (const path of files) {
    // Declaration bundlers may materialize external declarations here. Runtime
    // code is never valid: it ships a private dependency tree inside dist.
    if (
      path.startsWith('dist/node_modules/') &&
      !/\.d\.[cm]?ts(?:\.map)?$/.test(path)
    ) {
      failures.push(`${packageJson.name}: publishes nested dependency ${path}`);
    }
    if (/\.test(?:-d)?\./.test(path)) {
      failures.push(`${packageJson.name}: publishes test artifact ${path}`);
    }
  }

  const declared = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(packageJson.peerDependencies ?? {}),
  ]);
  let externalReferenceCount = 0;

  for (const path of sourceFiles) {
    for (const specifier of dependencySpecifiers(
      readSource(resolve(directory, path)),
    )) {
      const dependency = packageNameFromSpecifier(specifier);
      if (!dependency) continue;
      externalReferenceCount += 1;
      if (dependency !== packageJson.name && !declared.has(dependency)) {
        failures.push(
          `${packageJson.name}: ${path} imports undeclared dependency ${dependency}`,
        );
      }
    }
  }

  return {
    declarations: declarations.length,
    externalReferenceCount,
    failures,
    sources: sourceFiles.length,
  };
}
