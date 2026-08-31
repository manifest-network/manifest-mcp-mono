#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelative = 'submodules/fred/docs/manifest-schema.json';
const sourcePath = resolve(repoRoot, sourceRelative);
const vendoredPath = resolve(
  repoRoot,
  'packages/fred/schema/manifest-schema.json',
);
const provenancePath = resolve(
  repoRoot,
  'packages/fred/schema/manifest-schema.source.json',
);
const checkOnly = process.argv.includes('--check');

function git(args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
  }).trim();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(messages) {
  for (const message of messages) {
    process.stderr.write(`fred manifest schema: ${message}\n`);
  }
  process.exitCode = 1;
}

const indexedFredCommit = git(['rev-parse', ':submodules/fred']);

if (!checkOnly) {
  if (!existsSync(sourcePath)) {
    fail([
      `${sourceRelative} is unavailable; initialize the Fred submodule before syncing`,
    ]);
  } else {
    const checkedOutFredCommit = git([
      '-C',
      resolve(repoRoot, 'submodules/fred'),
      'rev-parse',
      'HEAD',
    ]);
    if (checkedOutFredCommit !== indexedFredCommit) {
      fail([
        `the Fred checkout is ${checkedOutFredCommit}, but the recorded gitlink is ${indexedFredCommit}`,
        'run git submodule update --init submodules/fred, then sync again',
      ]);
    } else {
      const sourceBytes = readFileSync(sourcePath);
      mkdirSync(dirname(vendoredPath), { recursive: true });
      writeFileSync(vendoredPath, sourceBytes);
      writeFileSync(
        provenancePath,
        `${JSON.stringify(
          {
            source: sourceRelative,
            fredCommit: indexedFredCommit,
            sha256: sha256(sourceBytes),
          },
          null,
          2,
        )}\n`,
      );
      process.stdout.write(
        `vendored Fred manifest schema from ${indexedFredCommit}\n`,
      );
    }
  }
} else {
  const errors = [];
  if (!existsSync(vendoredPath) || !existsSync(provenancePath)) {
    errors.push(
      'vendored schema or provenance is missing; run npm run sync:fred-manifest-schema',
    );
  } else {
    const vendoredBytes = readFileSync(vendoredPath);
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));

    if (provenance.source !== sourceRelative) {
      errors.push(`provenance source must be ${sourceRelative}`);
    }
    if (provenance.fredCommit !== indexedFredCommit) {
      errors.push(
        `Fred gitlink moved to ${indexedFredCommit}, but the schema records ${provenance.fredCommit}`,
      );
    }
    const vendoredSha = sha256(vendoredBytes);
    if (provenance.sha256 !== vendoredSha) {
      errors.push(
        `vendored schema SHA-256 is ${vendoredSha}, but provenance records ${provenance.sha256}`,
      );
    }

    // Regular CI intentionally checks out without submodules. The gitlink and
    // digest checks above still fail closed there. When the source checkout is
    // available (developer worktrees and E2E CI), also prove byte-for-byte
    // fidelity and catch a stale on-disk submodule.
    if (existsSync(sourcePath)) {
      const checkedOutFredCommit = git([
        '-C',
        resolve(repoRoot, 'submodules/fred'),
        'rev-parse',
        'HEAD',
      ]);
      if (checkedOutFredCommit !== indexedFredCommit) {
        errors.push(
          `Fred checkout ${checkedOutFredCommit} does not match gitlink ${indexedFredCommit}`,
        );
      }
      const sourceBytes = readFileSync(sourcePath);
      if (!sourceBytes.equals(vendoredBytes)) {
        errors.push(
          'vendored schema differs from the pinned Fred source; run npm run sync:fred-manifest-schema',
        );
      }
    }
  }

  if (errors.length > 0) {
    fail(errors);
  } else {
    process.stdout.write(
      `Fred manifest schema contract matches ${indexedFredCommit}\n`,
    );
  }
}
