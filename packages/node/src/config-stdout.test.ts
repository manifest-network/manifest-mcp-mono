import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
      NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
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

/** Exact source-map input bytes catch stale builds even when timestamps are preserved. */
function requireCurrentNodeBuild(moduleName: string): void {
  const sourceUrl = new URL(`./${moduleName}.ts`, import.meta.url);
  const builtUrl = new URL(`../dist/${moduleName}.js`, import.meta.url);
  const mapUrl = new URL(`${builtUrl.href}.map`);
  try {
    // The map alone is insufficient when a build was interrupted or output removed.
    readFileSync(builtUrl);
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
  } catch {
    throw new Error(
      `Missing or stale node/dist/${moduleName}.js. Run npm run build before the built CLI stdout tests.`,
    );
  }
}

describe('built CLI configuration stdout', () => {
  beforeAll(() => {
    // Sibling packages follow the workspace's normal build prerequisite; this
    // guard specifically pins the CLI and configuration sources exercised here.
    for (const moduleName of ['config', 'bootstrap', ...entrypoints]) {
      requireCurrentNodeBuild(moduleName);
    }
  });

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
