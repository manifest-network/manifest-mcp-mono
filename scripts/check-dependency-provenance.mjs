#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  lockedPackageName,
  requireSuccess,
  runNpm,
} from '../tools/consumer-packages.mjs';
import { assertVerifiedProvenance } from '../tools/npm-provenance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const requiredSources = {
  '@manifest-network/lcd': [
    'manifest-network/manifestjs',
    '.github/workflows/release.yaml',
    'refs/heads/main',
  ],
  '@manifest-network/ics23': [
    'manifest-network/cosmjs',
    '.github/workflows/manifest-release.yml',
    'refs/heads/manifest/0.32',
  ],
  '@manifest-network/stargate': [
    'manifest-network/cosmjs',
    '.github/workflows/manifest-release.yml',
    'refs/heads/manifest/0.32',
  ],
  '@manifest-network/manifestjs': [
    'manifest-network/manifestjs',
    '.github/workflows/release.yaml',
    'refs/heads/main',
  ],
};

export function assertVerifierVersion(result) {
  assert.equal(
    requireSuccess(result, 'Read npm verifier version').trim(),
    '11.19.1',
    'Provenance verification requires the reviewed npm 11.19.1 Sigstore verifier',
  );
}

/** The review record must cover every fork, including any nested installed copy. */
export function provenanceExpectations(evidence, lock) {
  assert.deepEqual(
    evidence.packages.map(({ name }) => name).sort(),
    Object.keys(requiredSources).sort(),
    'Provenance policy must cover exactly the four maintained dependencies',
  );
  return evidence.packages.map((record) => {
    const [repository, workflow, ref] = requiredSources[record.name];
    assert.deepEqual(
      record.source,
      {
        repository,
        workflow,
        ref,
        sha: record.source?.sha,
      },
      `Unexpected trusted source policy for ${record.name}`,
    );
    assert.match(
      record.source.sha,
      /^[a-f0-9]{40}$/,
      'Expected a reviewed full source commit',
    );
    assert.match(
      record.integrity,
      /^sha512-[A-Za-z0-9+/]{86}==$/,
      'Expected exact SHA-512 integrity',
    );
    assert.equal(new URL(record.tarball).origin, 'https://registry.npmjs.org');
    const copies = Object.entries(lock.packages ?? {}).filter(
      ([location, entry]) => lockedPackageName(location, entry) === record.name,
    );
    assert.ok(copies.length > 0, `Missing adopted dependency: ${record.name}`);
    for (const [location, entry] of copies) {
      assert.equal(
        entry.link,
        undefined,
        `Workspace dependency substituted for ${location}`,
      );
      assert.equal(
        entry.version,
        record.version,
        `Unreviewed dependency version: ${location}`,
      );
      assert.equal(
        entry.integrity,
        record.integrity,
        `Unreviewed dependency artifact: ${location}`,
      );
      assert.equal(
        entry.resolved,
        record.tarball,
        `Unexpected dependency registry: ${location}`,
      );
      assert.deepEqual(
        entry.dependencies,
        record.dependencies,
        `Unreviewed dependency declarations: ${location}`,
      );
    }
    return {
      name: record.name,
      version: record.version,
      integrity: record.integrity,
      ...record.source,
    };
  });
}

/** Release supplies the fresh consumer run; never silently skip a missing matrix. */
export function consumerDirectories(output) {
  const runs = readdirSync(output, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith('run-'),
  );
  assert.equal(runs.length, 1, 'Expected exactly one fresh consumer run');
  const run = join(output, runs[0].name);
  const summary = JSON.parse(readFileSync(join(run, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.map(({ target }) => target).sort(), [
    '@manifest-network/manifest-mcp-node',
    '@manifest-network/manifest-sdk',
  ]);
  assert.ok(
    summary.every((entry) => entry.passes === true),
    'Fresh consumer audit/import/identity checks must pass first',
  );
  return ['sdk', 'node'].map((name) => join(run, name));
}

export function verifyDirectory(directory, evidence, cache, destination) {
  assertVerifierVersion(runNpm(['--version'], directory, cache));
  const lock = JSON.parse(
    readFileSync(join(directory, 'package-lock.json'), 'utf8'),
  );
  const expectations = provenanceExpectations(evidence, lock);
  // No separately fetched bundle is accepted here: npm cryptographically
  // verifies these exact bundles, then the policy checks their authenticated
  // certificate and signed statement against the reviewed artifact/source.
  const result = runNpm(
    [
      'audit',
      'signatures',
      '--json',
      '--include-attestations',
      '--registry=https://registry.npmjs.org',
    ],
    directory,
    cache,
  );
  writeFileSync(destination, result.stdout);
  const audit = JSON.parse(
    requireSuccess(result, `Verify npm signatures in ${directory}`),
  );
  for (const expected of expectations)
    assertVerifiedProvenance(audit, expected);
  return expectations.map(({ name, version, sha }) => ({ name, version, sha }));
}

function main() {
  const { values } = parseArgs({
    options: { consumers: { type: 'string' } },
    allowPositionals: false,
  });
  const evidence = JSON.parse(
    readFileSync(join(root, 'docs/dependency-repair-2026-09-21.json'), 'utf8'),
  );
  const output = mkdtempSync(join(tmpdir(), 'manifest-provenance-'));
  const directories = [
    root,
    ...(values.consumers ? consumerDirectories(resolve(values.consumers)) : []),
  ];
  const results = [];
  for (const [index, directory] of directories.entries()) {
    try {
      const verified = verifyDirectory(
        directory,
        evidence,
        join(output, 'cache'),
        join(output, `signatures-${index}.json`),
      );
      results.push({ directory, passes: true, verified });
    } catch (error) {
      results.push({ directory, passes: false, error: error.message });
    }
  }
  writeFileSync(
    join(output, 'summary.json'),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.log(JSON.stringify({ output, results }, null, 2));
  if (results.some(({ passes }) => !passes)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
