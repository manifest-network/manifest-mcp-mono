#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelative = 'submodules/fred/docs/manifest-schema.json';
const limitsSourceRelative =
  'submodules/fred/internal/backend/shared/manifest/manifest.go';
const sourcePath = resolve(repoRoot, sourceRelative);
const limitsSourcePath = resolve(repoRoot, limitsSourceRelative);
const vendoredPath = resolve(
  repoRoot,
  'packages/fred/schema/manifest-schema.json',
);
const provenancePath = resolve(
  repoRoot,
  'packages/fred/schema/manifest-schema.source.json',
);
const generatedValidatorPath = resolve(
  repoRoot,
  'packages/fred/src/generated/fred-manifest-schema-validator.ts',
);
const generatedLimitsPath = resolve(
  repoRoot,
  'packages/fred/src/generated/fred-manifest-limits.ts',
);
const checkOnly = process.argv.includes('--check');

const GO_LIMITS = {
  maxTmpfsMounts: 'MaxTmpfsMounts',
  maxPorts: 'MaxPorts',
  maxExposePorts: 'MaxExposePorts',
  maxEnvVars: 'MaxEnvVars',
  maxLabels: 'MaxLabels',
};

function tryGit(args, errors, purpose) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : String(error);
    errors.push(
      `cannot ${purpose}: ${detail || 'git returned no diagnostic'}`,
      'run this command from a git checkout containing the submodules/fred gitlink',
    );
    return undefined;
  }
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

function readJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'run npm run sync:fred-manifest-schema to regenerate it',
    );
    return undefined;
  }
}

function parseGoLimits(source, errors) {
  const limits = {};
  for (const [key, goName] of Object.entries(GO_LIMITS)) {
    const match = source.match(new RegExp(`\\b${goName}\\s*=\\s*(\\d+)\\b`));
    if (!match) {
      errors.push(
        `could not find ${goName} in ${limitsSourceRelative}; update the sync parser for Fred's new declaration shape`,
      );
      continue;
    }
    limits[key] = Number(match[1]);
  }
  return Object.keys(limits).length === Object.keys(GO_LIMITS).length
    ? limits
    : undefined;
}

function validateRecordedLimits(limits, errors) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    errors.push('provenance limits must be an object');
    return undefined;
  }
  const normalized = {};
  for (const key of Object.keys(GO_LIMITS)) {
    const value = limits[key];
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`provenance limits.${key} must be a positive integer`);
    } else {
      normalized[key] = value;
    }
  }
  const unknown = Object.keys(limits).filter((key) => !(key in GO_LIMITS));
  if (unknown.length > 0) {
    errors.push(`provenance limits has unknown keys: ${unknown.join(', ')}`);
  }
  return errors.length === 0 ? normalized : undefined;
}

function generateValidator(schemaBytes, errors) {
  try {
    const schema = JSON.parse(schemaBytes.toString('utf8'));
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      // Fred's draft-2020-12 schema deliberately relies on applicable
      // subschema types and leaves tuple length open in two places. Disable
      // only those diagnostics; unknown keywords and every other strict
      // diagnostic remain fatal during sync/check.
      strictTypes: false,
      strictTuples: false,
      code: { source: true, esm: true, optimize: 2 },
    });
    const validate = ajv.compile(schema);
    let generated = standaloneCode(ajv, validate);
    // Ajv emits its Unicode-length helper as a CommonJS `require()` even in
    // ESM standalone mode. Inline the tiny equivalent so the published
    // neutral/browser build has no hidden Ajv runtime dependency or require
    // shim. Fail closed if a future Ajv version introduces another helper.
    generated = generated.replace(
      /const ([A-Za-z_$][\w$]*) = require\("ajv\/dist\/runtime\/ucs2length"\)\.default;/,
      'const $1 = (value) => Array.from(value).length;',
    );
    const runtimeImports = [
      ...(generated.match(/\brequire\([^)]+\)/g) ?? []),
      ...(generated.match(/\bimport\s*\([^)]+\)/g) ?? []),
      ...(generated.match(/\bimport\s+[^;]+\s+from\s+["'][^"']+["']/g) ?? []),
    ];
    if (runtimeImports.length > 0) {
      throw new Error(
        `standalone output still has runtime imports: ${runtimeImports.join(', ')}`,
      );
    }
    return Buffer.from(
      '// @ts-nocheck -- generated by scripts/sync-fred-manifest-schema.mjs\n' +
        '// Do not edit; regenerate with npm run sync:fred-manifest-schema.\n' +
        `${generated}\n`,
    );
  } catch (error) {
    errors.push(
      `cannot compile the vendored schema in strict mode: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function validateSchemaGoAlignment(schemaBytes, limits, errors) {
  let schema;
  try {
    schema = JSON.parse(schemaBytes.toString('utf8'));
  } catch {
    // generateValidator reports the actionable parse/compile diagnostic.
    return;
  }
  const schemaTmpfsLimit =
    schema?.$defs?.DockerManifestBase?.properties?.tmpfs?.maxItems;
  if (schemaTmpfsLimit !== limits.maxTmpfsMounts) {
    errors.push(
      `schema tmpfs.maxItems is ${String(schemaTmpfsLimit)}, but pinned Fred MaxTmpfsMounts is ${limits.maxTmpfsMounts}`,
    );
  }
}

function generateLimitsModule(limits) {
  return Buffer.from(
    '// Generated by scripts/sync-fred-manifest-schema.mjs from Fred manifest.go.\n' +
      '// Do not edit; regenerate with npm run sync:fred-manifest-schema.\n' +
      `export const FRED_MANIFEST_LIMITS = ${JSON.stringify(limits, null, 2)} as const;\n`,
  );
}

function compareBytes(actualPath, expected, label, errors) {
  if (!existsSync(actualPath)) {
    errors.push(`${label} is missing; run npm run sync:fred-manifest-schema`);
    return;
  }
  if (!readFileSync(actualPath).equals(expected)) {
    errors.push(`${label} is stale; run npm run sync:fred-manifest-schema`);
  }
}

function sync(indexedFredCommit, errors) {
  if (!existsSync(sourcePath) || !existsSync(limitsSourcePath)) {
    errors.push(
      'the Fred schema or manifest.go source is unavailable; initialize the Fred submodule before syncing',
    );
    return;
  }

  const checkedOutFredCommit = tryGit(
    ['-C', resolve(repoRoot, 'submodules/fred'), 'rev-parse', 'HEAD'],
    errors,
    'read the checked-out Fred commit',
  );
  if (!checkedOutFredCommit) return;
  if (checkedOutFredCommit !== indexedFredCommit) {
    errors.push(
      `the Fred checkout is ${checkedOutFredCommit}, but the recorded gitlink is ${indexedFredCommit}`,
      'run git submodule update --init submodules/fred, then sync again',
    );
    return;
  }

  const sourceBytes = readFileSync(sourcePath);
  const limits = parseGoLimits(readFileSync(limitsSourcePath, 'utf8'), errors);
  if (limits) validateSchemaGoAlignment(sourceBytes, limits, errors);
  const validatorBytes = generateValidator(sourceBytes, errors);
  if (!limits || !validatorBytes || errors.length > 0) return;

  mkdirSync(dirname(vendoredPath), { recursive: true });
  mkdirSync(dirname(generatedValidatorPath), { recursive: true });
  writeFileSync(vendoredPath, sourceBytes);
  writeFileSync(
    provenancePath,
    `${JSON.stringify(
      {
        source: sourceRelative,
        limitsSource: limitsSourceRelative,
        fredCommit: indexedFredCommit,
        sha256: sha256(sourceBytes),
        limits,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(generatedValidatorPath, validatorBytes);
  writeFileSync(generatedLimitsPath, generateLimitsModule(limits));
  process.stdout.write(
    `vendored Fred manifest contract from ${indexedFredCommit}\n`,
  );
}

function check(indexedFredCommit, errors) {
  if (!existsSync(vendoredPath) || !existsSync(provenancePath)) {
    errors.push(
      'vendored schema or provenance is missing; run npm run sync:fred-manifest-schema',
    );
    return;
  }

  const vendoredBytes = readFileSync(vendoredPath);
  const provenance = readJson(provenancePath, 'schema provenance', errors);
  if (!provenance) return;

  if (provenance.source !== sourceRelative) {
    errors.push(`provenance source must be ${sourceRelative}`);
  }
  if (provenance.limitsSource !== limitsSourceRelative) {
    errors.push(`provenance limitsSource must be ${limitsSourceRelative}`);
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

  const limitErrors = [];
  const limits = validateRecordedLimits(provenance.limits, limitErrors);
  errors.push(...limitErrors);
  if (limits) validateSchemaGoAlignment(vendoredBytes, limits, errors);
  const validatorBytes = generateValidator(vendoredBytes, errors);
  if (validatorBytes) {
    compareBytes(
      generatedValidatorPath,
      validatorBytes,
      'generated Fred schema validator',
      errors,
    );
  }
  if (limits) {
    compareBytes(
      generatedLimitsPath,
      generateLimitsModule(limits),
      'generated Fred manifest limits',
      errors,
    );
  }

  // Regular CI intentionally checks out without submodules. The gitlink,
  // digest, generated-validator, and generated-limit checks above still fail
  // closed there. With a Fred checkout, also prove the source bytes, Go caps,
  // and checked-out commit all match the gitlink.
  if (existsSync(sourcePath) || existsSync(limitsSourcePath)) {
    if (!existsSync(sourcePath) || !existsSync(limitsSourcePath)) {
      errors.push(
        'the Fred submodule checkout is partial: schema and manifest.go must either both exist or both be absent',
      );
      return;
    }
    const checkedOutFredCommit = tryGit(
      ['-C', resolve(repoRoot, 'submodules/fred'), 'rev-parse', 'HEAD'],
      errors,
      'read the checked-out Fred commit',
    );
    if (checkedOutFredCommit && checkedOutFredCommit !== indexedFredCommit) {
      errors.push(
        `Fred checkout ${checkedOutFredCommit} does not match gitlink ${indexedFredCommit}`,
      );
    }
    if (!readFileSync(sourcePath).equals(vendoredBytes)) {
      errors.push(
        'vendored schema differs from the pinned Fred source; run npm run sync:fred-manifest-schema',
      );
    }
    const sourceLimitErrors = [];
    const sourceLimits = parseGoLimits(
      readFileSync(limitsSourcePath, 'utf8'),
      sourceLimitErrors,
    );
    errors.push(...sourceLimitErrors);
    if (
      sourceLimits &&
      limits &&
      JSON.stringify(sourceLimits) !== JSON.stringify(limits)
    ) {
      errors.push(
        `recorded limits ${JSON.stringify(limits)} differ from pinned Fred ${JSON.stringify(sourceLimits)}; run npm run sync:fred-manifest-schema`,
      );
    }
  }

  if (errors.length === 0) {
    process.stdout.write(
      `Fred manifest schema contract matches ${indexedFredCommit}\n`,
    );
  }
}

const errors = [];
const indexedFredCommit = tryGit(
  ['rev-parse', ':submodules/fred'],
  errors,
  'read the submodules/fred gitlink',
);
if (indexedFredCommit) {
  if (checkOnly) check(indexedFredCommit, errors);
  else sync(indexedFredCommit, errors);
}
if (errors.length > 0) fail(errors);
