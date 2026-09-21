#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  auditResult,
  installConsumer,
  packPackage,
  requireSuccess,
  runNpm,
  runtimeClosure,
  verifyInstalledTarballs,
  writeConsumer,
} from '../tools/consumer-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    'published-version': { type: 'string' },
  },
  allowPositionals: false,
});
const publishedVersion = values['published-version'];
assert.ok(
  publishedVersion === undefined ||
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(publishedVersion),
  '--published-version must be an exact stable version, for example 0.22.0',
);
const output = values.output
  ? resolve(values.output)
  : mkdtempSync(join(tmpdir(), 'manifest-consumers-'));
mkdirSync(output, { recursive: true });
const fromWorkspace = relative(realpathSync(root), realpathSync(output));
assert.ok(
  fromWorkspace === '..' ||
    fromWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(fromWorkspace),
  '--output must be outside the workspace so consumer imports cannot fall back to its node_modules',
);
const runDirectory = mkdtempSync(join(output, 'run-'));
const cache = join(runDirectory, 'npm-cache');
const tarballs = join(runDirectory, 'tarballs');
mkdirSync(tarballs);
console.log(`Consumer audit evidence: ${runDirectory}`);

const packages = new Map();
for (const entry of readdirSync(join(root, 'packages'), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  const directory = join(root, 'packages', entry.name);
  const packageJson = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  );
  if (packageJson.private) continue;
  packages.set(packageJson.name, { directory, packageJson });
}
if (!publishedVersion) {
  for (const entry of packages.values()) {
    entry.pack = packPackage(entry.directory, tarballs, cache);
  }
  writeFileSync(
    join(runDirectory, 'tarballs.json'),
    `${JSON.stringify(
      [...packages].map(([name, entry]) => ({ name, ...entry.pack })),
      null,
      2,
    )}\n`,
  );
}

const sdk = '@manifest-network/manifest-sdk';
const node = '@manifest-network/manifest-mcp-node';
const results = [];
for (const target of [sdk, node]) {
  const directory = join(runDirectory, target === sdk ? 'sdk' : 'node');
  const summary = {
    target,
    source: publishedVersion ? `published@${publishedVersion}` : 'workspace',
    passes: false,
  };
  results.push(summary);
  try {
    // Pack only the exact public entry package. Its siblings must resolve from
    // their published declarations, without workspace stand-ins or overrides.
    const selected = publishedVersion
      ? new Map([
          [
            target,
            {
              packageJson: { name: target, version: publishedVersion },
              pack: packPackage(
                runDirectory,
                tarballs,
                cache,
                `${target}@${publishedVersion}`,
              ),
            },
          ],
        ])
      : runtimeClosure(target, packages);
    writeConsumer(directory, selected);
    const install = installConsumer(directory, cache);
    writeFileSync(
      join(directory, 'install.log'),
      `${install.stdout}\n${install.stderr}`,
    );
    requireSuccess(install, `Install ${target}`);
    // Gather audit and smoke evidence even when an old release has skew; the
    // identity failure still makes the final result fail.
    let identityError;
    try {
      verifyInstalledTarballs(directory, selected);
      summary.identityPasses = true;
    } catch (error) {
      summary.identityPasses = false;
      identityError = error;
      summary.identityError = error.message;
    }
    if (publishedVersion) {
      selected.get(target).packageJson = JSON.parse(
        readFileSync(
          join(directory, 'node_modules', target, 'package.json'),
          'utf8',
        ),
      );
    }
    const tree = runNpm(
      ['ls', '--all', '--json', '--omit=dev'],
      directory,
      cache,
    );
    writeFileSync(join(directory, 'dependency-tree.json'), tree.stdout);
    requireSuccess(tree, `Validate installed dependency graph for ${target}`);

    const audit = runNpm(
      [
        'audit',
        '--json',
        '--omit=dev',
        '--include=optional',
        '--include=peer',
        '--audit-level=high',
      ],
      directory,
      cache,
    );
    writeFileSync(join(directory, 'audit.json'), audit.stdout);
    writeFileSync(join(directory, 'audit.stderr.log'), audit.stderr);
    const assessed = auditResult(audit);
    summary.vulnerabilities = assessed.counts;
    summary.auditPasses = assessed.passes;

    // Import every public runtime entry. No chain/provider calls, keys, or transaction signing.
    const imports = [...selected].flatMap(([name, entry]) =>
      Object.entries(entry.packageJson.exports ?? {})
        .filter(
          ([subpath]) =>
            !subpath.includes('__test-utils__') && subpath !== './package.json',
        )
        .map(([subpath]) =>
          subpath === '.' ? name : `${name}/${subpath.slice(2)}`,
        ),
    );
    writeFileSync(
      join(directory, 'smoke.mjs'),
      `import assert from 'node:assert/strict';\n` +
        `for (const specifier of ${JSON.stringify(imports)}) {\n` +
        `  const module = await import(specifier);\n` +
        `  assert.ok(Object.keys(module).length > 0, specifier);\n` +
        `}\n` +
        `console.log('Imported ${imports.length} packed public entry points.');\n`,
    );
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const smoke = spawnSync(process.execPath, ['smoke.mjs'], {
      cwd: directory,
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    writeFileSync(
      join(directory, 'smoke.log'),
      `${smoke.stdout}\n${smoke.stderr}`,
    );
    if (smoke.error) throw smoke.error;
    requireSuccess(smoke, `Import smoke test for ${target}`);
    for (const [command, relativePath] of Object.entries(
      selected.get(target).packageJson.bin ?? {},
    )) {
      const binary = join(directory, 'node_modules', target, relativePath);
      // An invalid subcommand prints usage before resolving configuration or a wallet.
      const cli = spawnSync(process.execPath, [binary, '__consumer_smoke__'], {
        cwd: directory,
        encoding: 'utf8',
        env,
        timeout: 30_000,
      });
      writeFileSync(
        join(directory, `${command}.log`),
        `${cli.stdout}\n${cli.stderr}`,
      );
      if (cli.error) throw cli.error;
      assert.equal(
        cli.status,
        1,
        `${command}: expected invalid-subcommand exit`,
      );
      assert.ok(
        cli.stderr.includes(`Unknown subcommand: "__consumer_smoke__"`),
        cli.stderr,
      );
      assert.ok(cli.stderr.includes(`${command} keygen`), cli.stderr);
    }
    summary.smokePasses = true;
    summary.passes = assessed.passes && !identityError;
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  }
  console.log(JSON.stringify(summary));
}
writeFileSync(
  join(runDirectory, 'summary.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);
if (results.some((result) => !result.passes)) {
  console.error(`Consumer validation failed. Full reports: ${runDirectory}`);
  process.exitCode = 1;
}
