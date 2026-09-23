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

function isDeclarationFile(path) {
  return /\.d\.[cm]?ts$/.test(path);
}

function hasExportModifier(node) {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function declaredNames(statement, file) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.map((declaration) =>
      declaration.name.getText(file),
    );
  }
  if (ts.isModuleDeclaration(statement)) {
    // `declare module 'x'` and `declare global` augment other scopes; they do
    // not add members to this module.
    if (
      ts.isStringLiteral(statement.name) ||
      statement.flags & ts.NodeFlags.GlobalAugmentation
    ) {
      return [];
    }
    return [statement.name.text];
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name ? [statement.name.text] : [];
  }
  // Imports are aliases, which TypeScript never exports implicitly.
  return [];
}

/**
 * A declaration file with no top-level export declaration or export
 * assignment (`export {…}`, `export type {…}`, `export *`, `export =`, or
 * `export default X;`) is an export context: TypeScript treats every
 * top-level declaration in it as exported, including those the source kept
 * private. Inline `export` modifiers, `export default function` included, do
 * not count. tsc emits `export {}` to prevent this. rolldown-plugin-dts 0.28
 * (tsdown 0.23) inlines `export` modifiers and drops that statement, which
 * made core `/faucet` advertise private schemas that fail at ESM link time.
 * Returns the names a file would expose that way; a script file would make
 * them global. Namespace bodies follow the same rule but are not inspected:
 * no packed declaration declares a namespace.
 */
export function implicitDeclarationExports(source, fileName = 'index.d.ts') {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  if (
    file.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
    )
  ) {
    return [];
  }
  return [
    ...new Set(
      file.statements
        .filter((statement) => !hasExportModifier(statement))
        .flatMap((statement) => declaredNames(statement, file)),
    ),
  ];
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
  const declarations = files.filter(isDeclarationFile);

  if (!files.some((path) => path.startsWith('dist/'))) {
    failures.push(
      `${packageJson.name}: npm pack contains no dist/ files; run the build first`,
    );
  }
  if (sourceFiles.length === 0) {
    failures.push(
      `${packageJson.name}: no shipped JS/declaration sources found; dependency gate is vacuous`,
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
    const source = readSource(resolve(directory, path));
    for (const specifier of dependencySpecifiers(source)) {
      const dependency = packageNameFromSpecifier(specifier);
      if (!dependency) continue;
      externalReferenceCount += 1;
      if (dependency !== packageJson.name && !declared.has(dependency)) {
        failures.push(
          `${packageJson.name}: ${path} imports undeclared dependency ${dependency}`,
        );
      }
    }
    if (isDeclarationFile(path)) {
      const implicit = implicitDeclarationExports(source, path);
      if (implicit.length > 0) {
        failures.push(
          `${packageJson.name}: ${path} has no export statement, so TypeScript exposes private declarations ${implicit.join(', ')}`,
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
