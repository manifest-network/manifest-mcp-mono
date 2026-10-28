import { builtinModules } from 'node:module';
import { rolldown } from 'rolldown';
import ts from 'typescript';

/** Browser bundles parse multi-megabyte CosmJS graphs on slower CI runners. */
export const BROWSER_BUNDLE_TIMEOUT_MS = 30_000;

export interface EmittedChunk {
  /** The chunk exactly as rolldown emits it. */
  code: string;
  /**
   * Rolldown's rendered code for each module in the chunk, keyed by module id
   * (`RenderedModule.code`; `null` when nothing of the module is rendered).
   */
  modules: Readonly<Record<string, string | null>>;
}

export interface BrowserBundle {
  code: string;
  chunks: EmittedChunk[];
  modules: string[];
  unresolvedWarnings: string[];
}

export interface NodeOnlyImport {
  expression: string;
  specifier: string;
  /** The module id whose rendered code accounts for the import, if any. */
  importer?: string;
}

interface NodeOnlyReference {
  expression: string;
  specifier: string;
  isRequire: boolean;
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

const GUARDED_COSMJS_CRYPTO_MODULES =
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
    const chunks = output.filter((item) => item.type === 'chunk');
    return {
      code: chunks.map((item) => item.code).join('\n'),
      chunks: chunks.map((item) => ({
        code: item.code,
        modules: Object.fromEntries(
          Object.entries(item.modules).map(([id, rendered]) => [
            id,
            rendered.code,
          ]),
        ),
      })),
      modules: chunks.flatMap((item) => Object.keys(item.modules)),
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

function isNodeOnlySpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    BUILTIN_SPECIFIERS.has(specifier) ||
    NODE_SHIMS.has(specifier)
  );
}

function isGuardedCosmjsCrypto(
  reference: NodeOnlyReference,
  importer: string,
): boolean {
  return (
    reference.specifier === 'crypto' &&
    reference.isRequire &&
    GUARDED_COSMJS_CRYPTO_MODULES.test(importer.replaceAll('\\', '/'))
  );
}

function sameReference(a: NodeOnlyReference, b: NodeOnlyReference): boolean {
  return a.specifier === b.specifier && a.isRequire === b.isRequire;
}

/**
 * Find Node-only imports in emitted chunks, including rolldown's CJS
 * `__require(...)` form and every bare builtin known to the running Node.
 *
 * Every reference in the chunk's own code is checked. A reference is
 * attributed to a module only when that module's rendered code contains a
 * reference of the same kind and specifier that no other module has claimed,
 * so attribution comes from rolldown's module ids rather than from comments
 * the bundled code could imitate. Rolldown 1.2.15 replaced the `//#region`
 * pairs this once read with `// <id>` lines (ENG-2093), and rendered module
 * code is not a byte-exact slice of the chunk, so references are matched by
 * count rather than by offset. A reference no module accounts for is a leak.
 * So is a module reference with no counterpart in the chunk, because then the
 * rendered modules no longer describe what the chunk ships.
 */
export function findNodeOnlyImports(
  chunks: readonly EmittedChunk[],
): NodeOnlyImport[] {
  const leaks: NodeOnlyImport[] = [];
  for (const chunk of chunks) {
    const shipped = scanNodeOnlyReferences(chunk.code).map((reference) => ({
      reference,
      importer: undefined as string | undefined,
    }));
    const unmatched: NodeOnlyImport[] = [];
    for (const [importer, code] of Object.entries(chunk.modules)) {
      if (!code) continue;
      for (const reference of scanNodeOnlyReferences(code)) {
        const match = shipped.find(
          (entry) =>
            entry.importer === undefined &&
            sameReference(entry.reference, reference),
        );
        if (match) {
          match.importer = importer;
        } else {
          const { expression, specifier } = reference;
          unmatched.push({ expression, specifier, importer });
        }
      }
    }
    for (const { reference, importer } of shipped) {
      if (importer !== undefined && isGuardedCosmjsCrypto(reference, importer))
        continue;
      const { expression, specifier } = reference;
      leaks.push({ expression, specifier, importer });
    }
    leaks.push(...unmatched);
  }
  return leaks;
}

function scanNodeOnlyReferences(code: string): NodeOnlyReference[] {
  const source = ts.createSourceFile(
    'browser-bundle.js',
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const references: NodeOnlyReference[] = [];

  function inspectSpecifier(
    specifierNode: ts.Expression,
    owner: ts.Node,
    isRequire: boolean,
  ): void {
    if (!ts.isStringLiteralLike(specifierNode)) return;
    const specifier = specifierNode.text;
    if (!isNodeOnlySpecifier(specifier)) return;
    references.push({
      expression: owner.getText(source),
      specifier,
      isRequire,
    });
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
  return references;
}

/** Positive proof that the browser crypto path was retained in the bundle. */
export function hasWebCryptoFallback(code: string): boolean {
  return /globalThis\.crypto|crypto\.subtle|getRandomValues/.test(code);
}
