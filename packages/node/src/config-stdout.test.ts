import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = CHILD_TIMEOUT_MS + 10_000;
const entrypoints = ['chain', 'lease', 'fred', 'cosmwasm', 'agent'];

const loggingSettings = [
  { DOTENV_CONFIG_DEBUG: 'true' },
  { DOTENV_CONFIG_QUIET: 'false' },
  { DOTENV_CONFIG_DEBUG: 'true', DOTENV_CONFIG_QUIET: 'false' },
];
const loggingCases = [
  { name: 'default settings', environment: {}, fileSettings: {} },
  ...loggingSettings.flatMap((settings) => [
    {
      name: `process environment ${JSON.stringify(settings)}`,
      environment: settings,
      fileSettings: {},
    },
    {
      name: `.env ${JSON.stringify(settings)}`,
      environment: {},
      fileSettings: settings,
    },
  ]),
];

let directory: string;
let compileCache: string;

beforeAll(() => {
  compileCache = mkdtempSync(join(tmpdir(), 'manifest-config-cache-'));
});

afterAll(() => {
  rmSync(compileCache, { recursive: true, force: true });
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'manifest-config-stdout-'));
  writeFileSync(
    join(directory, '.env'),
    'COSMOS_CHAIN_ID=stdio-test-chain\nCOSMOS_REST_URL=https://rest.invalid\n',
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Keep the real loader isolated from inherited credentials, dotenv options and NODE_OPTIONS. */
function runNode(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, args, {
    cwd: directory,
    env: {
      NODE_COMPILE_CACHE: compileCache,
      TMPDIR: tmpdir(),
      NO_COLOR: '1',
      ...environment,
    },
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
}

describe('source configuration stdout', () => {
  it.each(loggingCases)(
    'loads .env silently with $name',
    ({ environment, fileSettings }) => {
      appendFileSync(
        join(directory, '.env'),
        Object.entries(fileSettings)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
      // Native Node type stripping executes the current source and real dotenv;
      // this regression cannot pass against a stale dist/config.js.
      const moduleUrl = new URL('./config.ts', import.meta.url).href;
      const settings = { ...fileSettings, ...environment };
      const result = runNode(
        [
          '--input-type=module',
          '--eval',
          `import { loadConfig } from ${JSON.stringify(moduleUrl)};
const config = loadConfig();
if (config.chainId !== 'stdio-test-chain' || config.restUrl !== 'https://rest.invalid') {
  process.exitCode = 2;
}
for (const [key, value] of Object.entries(${JSON.stringify(settings)})) {
  if (process.env[key] !== value) process.exitCode = 3;
}`,
        ],
        environment,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
    },
    TEST_TIMEOUT_MS,
  );
});

/** Follow the built static startup graph and check each module's source-map input. */
function requireCurrentNodeBuild(builtUrl: URL, visited: Set<string>): void {
  if (visited.has(builtUrl.href)) return;
  visited.add(builtUrl.href);
  const distUrl = new URL('../dist/', import.meta.url);
  if (!builtUrl.href.startsWith(distUrl.href)) {
    throw new Error(`Startup import leaves the node package: ${builtUrl.href}`);
  }
  const sourceUrl = new URL(
    builtUrl.href.slice(distUrl.href.length).replace(/\.js$/, '.ts'),
    new URL('./', import.meta.url),
  );
  const mapUrl = new URL(`${builtUrl.href}.map`);
  let imports: string[];
  try {
    const built = readFileSync(builtUrl, 'utf8');
    const syntax = ts.createSourceFile(
      fileURLToPath(builtUrl),
      built,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.JS,
    );
    if (
      syntax.statements.length === 0 ||
      !built.includes(`//# sourceMappingURL=${basename(mapUrl.pathname)}`)
    ) {
      throw new Error('built JavaScript is empty or lacks its source-map link');
    }
    const map = JSON.parse(readFileSync(mapUrl, 'utf8')) as {
      sources: string[];
      sourcesContent: string[];
    };
    const index = map.sources.findIndex(
      (source) => new URL(source, mapUrl).href === sourceUrl.href,
    );
    if (
      index < 0 ||
      map.sourcesContent[index] !== readFileSync(sourceUrl, 'utf8')
    ) {
      throw new Error('build input differs from current source');
    }
    imports = syntax.statements.flatMap((statement) => {
      const specifier =
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      return specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith('.')
        ? [specifier.text]
        : [];
    });
  } catch (cause) {
    throw new Error(
      `Missing, invalid or stale ${fileURLToPath(builtUrl)}. Run npm run build before the built CLI stdout tests.`,
      { cause },
    );
  }
  for (const specifier of imports) {
    requireCurrentNodeBuild(new URL(specifier, builtUrl), visited);
  }
}

describe('built CLI configuration stdout', () => {
  beforeAll(() => {
    // Package imports retain the workspace build prerequisite. Static relative
    // imports are discovered from the actual bytes, including keyfileWallet.
    const visited = new Set<string>();
    for (const moduleName of entrypoints) {
      requireCurrentNodeBuild(
        new URL(`../dist/${moduleName}.js`, import.meta.url),
        visited,
      );
    }
  });

  it(
    'loads .env through the built configuration module',
    () => {
      const moduleUrl = new URL('../dist/config.js', import.meta.url).href;
      const result = runNode([
        '--input-type=module',
        '--eval',
        `import { loadConfig } from ${JSON.stringify(moduleUrl)};
const config = loadConfig();
if (config.chainId !== 'stdio-test-chain' || config.restUrl !== 'https://rest.invalid') {
  process.exitCode = 2;
}`,
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe('');
    },
    TEST_TIMEOUT_MS,
  );

  it.each(entrypoints)(
    '%s CLI keeps stdout empty through initialization before an early usage error',
    (entrypoint) => {
      appendFileSync(
        join(directory, '.env'),
        'DOTENV_CONFIG_DEBUG=true\nDOTENV_CONFIG_QUIET=false\n',
      );
      // The unknown subcommand exits before wallet creation or any network access.
      const result = runNode(
        [
          fileURLToPath(new URL(`../dist/${entrypoint}.js`, import.meta.url)),
          '__stdio_output_probe__',
        ],
        { DOTENV_CONFIG_DEBUG: 'true', DOTENV_CONFIG_QUIET: 'false' },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Unknown subcommand: "__stdio_output_probe__"',
      );
      expect(result.stdout).toBe('');
    },
    TEST_TIMEOUT_MS,
  );
});
