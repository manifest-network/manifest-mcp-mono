import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

/** Run built entry points like the CLI does, with real dotenv and no inherited app credentials. */
function runNode(args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: directory,
    env: {
      NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
      TMPDIR: tmpdir(),
      NO_COLOR: '1',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

describe('built CLI configuration stdout', () => {
  it('loads a real .env file without writing startup diagnostics to stdout', () => {
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
  });

  it.each(['chain', 'lease', 'fred', 'cosmwasm', 'agent'])(
    '%s CLI keeps stdout empty through initialization before an early usage error',
    (entrypoint) => {
      // The unknown subcommand exits before wallet creation or any network access.
      const result = runNode([
        fileURLToPath(new URL(`../dist/${entrypoint}.js`, import.meta.url)),
        '__stdio_output_probe__',
      ]);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Unknown subcommand: "__stdio_output_probe__"',
      );
      expect(result.stdout).toBe('');
    },
  );
});
