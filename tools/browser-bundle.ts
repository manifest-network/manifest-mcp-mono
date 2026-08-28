import { builtinModules } from 'node:module';
import { rolldown } from 'rolldown';
import ts from 'typescript';

/** Browser bundles parse multi-megabyte CosmJS graphs on slower CI runners. */
export const BROWSER_BUNDLE_TIMEOUT_MS = 30_000;

export interface BrowserBundle {
  code: string;
  unresolvedWarnings: string[];
}

export interface NodeOnlyImport {
  expression: string;
  specifier: string;
  importerRegion?: string;
}

const BUILTIN_SPECIFIERS = new Set(
  builtinModules.flatMap((specifier) => [
    specifier,
    specifier.startsWith('node:') ? specifier.slice(5) : `node:${specifier}`,
  ]),
);

const NODE_SHIMS = new Set([
  'crypto-browserify',
  'process/browser',
  'stream-browserify',
  'undici',
  'ws',
]);

// This is the one known browser-safe unresolved import in the pinned CosmJS
// graph. Match both the exact specifier and its exact source module: matching
// only the importer package would also excuse a future child_process/fs leak.
const GUARDED_COSMJS_CRYPTO_WARNING =
  /Could not resolve ['"]crypto['"] in .*node_modules\/@cosmjs\/crypto\/build\/pbkdf2\.js(?:\s|$)/;

const GUARDED_COSMJS_CRYPTO_REGIONS =
  /(?:^|\/)node_modules\/@cosmjs\/crypto\/build\/(?:pbkdf2|random)\.js$/;

/** Bundle one entry under browser conditions and retain unresolved-import diagnostics. */
export async function bundleForBrowser(input: string): Promise<BrowserBundle> {
  const unresolvedWarnings: string[] = [];
  const bundle = await rolldown({
    input,
    platform: 'browser',
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT') {
        unresolvedWarnings.push(log.message ?? String(log));
      }
    },
  });

  try {
    const { output } = await bundle.generate({ format: 'esm' });
    return {
      code: output
        .filter((item) => item.type === 'chunk')
        .map((item) => item.code)
        .join('\n'),
      unresolvedWarnings,
    };
  } finally {
    await bundle.close();
  }
}

/** Return warnings not covered by the exact, guarded CosmJS crypto fallback. */
export function unallowedBrowserWarnings(
  warnings: readonly string[],
): string[] {
  return warnings.filter(
    (warning) =>
      !GUARDED_COSMJS_CRYPTO_WARNING.test(warning.replaceAll('\\', '/')),
  );
}

function importerRegionAt(code: string, offset: number): string | undefined {
  const start = code.lastIndexOf('//#region ', offset);
  if (start < 0 || code.lastIndexOf('//#endregion', offset) > start) {
    return undefined;
  }
  const pathStart = start + '//#region '.length;
  const pathEnd = code.indexOf('\n', pathStart);
  return code.slice(pathStart, pathEnd < 0 ? undefined : pathEnd).trim();
}

function isNodeOnlySpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    BUILTIN_SPECIFIERS.has(specifier) ||
    NODE_SHIMS.has(specifier)
  );
}

/**
 * Find Node-only imports in emitted code, including rolldown's CJS
 * `__require(...)` form and every bare builtin known to the running Node.
 */
export function findNodeOnlyImports(code: string): NodeOnlyImport[] {
  const source = ts.createSourceFile(
    'browser-bundle.js',
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const leaks: NodeOnlyImport[] = [];

  function inspectSpecifier(
    specifierNode: ts.Expression,
    owner: ts.Node,
    isRequire: boolean,
  ): void {
    if (!ts.isStringLiteralLike(specifierNode)) return;
    const specifier = specifierNode.text;
    if (!isNodeOnlySpecifier(specifier)) return;

    const offset = owner.getStart(source);
    const importerRegion = importerRegionAt(code, offset);
    const guardedCosmjsCrypto =
      specifier === 'crypto' &&
      isRequire &&
      importerRegion !== undefined &&
      GUARDED_COSMJS_CRYPTO_REGIONS.test(importerRegion.replaceAll('\\', '/'));
    if (!guardedCosmjsCrypto) {
      leaks.push({
        expression: owner.getText(source),
        specifier,
        importerRegion,
      });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        inspectSpecifier(node.moduleSpecifier, node, false);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'require' ||
          node.expression.text === '__require');
      if (isDynamicImport || isRequire) {
        inspectSpecifier(node.arguments[0], node, isRequire);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return leaks;
}

/** Positive proof that the browser crypto path was retained in the bundle. */
export function hasWebCryptoFallback(code: string): boolean {
  return /globalThis\.crypto|crypto\.subtle|getRandomValues/.test(code);
}
