#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const AJV_VERSION = createRequire(import.meta.url)('ajv/package.json').version;

const GO_LIMITS = {
  maxTmpfsMounts: 'MaxTmpfsMounts',
  maxPorts: 'MaxPorts',
  maxExposePorts: 'MaxExposePorts',
  maxEnvVars: 'MaxEnvVars',
  maxLabels: 'MaxLabels',
  dependsOnMaxDepth: 'dependsOnMaxDepth',
};
const GENERATED_LIMIT_KEYS = [
  ...Object.keys(GO_LIMITS),
  'minStopGracePeriodNanoseconds',
  'maxStopGracePeriodNanoseconds',
];

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

export function finish(
  messages,
  {
    writeError = (message) => process.stderr.write(message),
    setExitCode = (code) => {
      process.exitCode = code;
    },
  } = {},
) {
  if (messages.length === 0) return true;
  for (const message of messages) {
    writeError(`fred manifest schema: ${message}\n`);
  }
  setExitCode(1);
  return false;
}

function readBytes(path, label, errors) {
  try {
    return readFileSync(path);
  } catch (error) {
    errors.push(
      `cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function readText(path, label, errors) {
  const bytes = readBytes(path, label, errors);
  return bytes?.toString('utf8');
}

function readJson(path, label, errors) {
  const text = readText(path, label, errors);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'run npm run sync:fred-manifest-schema to regenerate it',
    );
    return undefined;
  }
}

export function validateProvenanceShape(value, errors) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('schema provenance must be a JSON object');
    return undefined;
  }
  return value;
}

/** Remove comments and quoted literals while preserving line structure. */
export function stripGoNonCode(source) {
  let state = 'code';
  let output = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        output += '  ';
        index++;
        state = 'line-comment';
      } else if (char === '/' && next === '*') {
        output += '  ';
        index++;
        state = 'block-comment';
      } else if (char === '"' || char === "'") {
        output += ' ';
        state = char === '"' ? 'string' : 'rune';
      } else if (char === '`') {
        output += ' ';
        state = 'raw-string';
      } else {
        output += char;
      }
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        output += '\n';
        state = 'code';
      } else {
        output += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index++;
        state = 'code';
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    const terminator = state === 'string' ? '"' : state === 'rune' ? "'" : '`';
    if (state !== 'raw-string' && char === '\\') {
      output += ' ';
      if (next !== undefined) {
        output += next === '\n' ? '\n' : ' ';
        index++;
      }
    } else if (char === terminator) {
      output += ' ';
      state = 'code';
    } else {
      output += char === '\n' ? '\n' : ' ';
    }
  }
  return output;
}

function parsePlainIntegerDeclaration(code, goName, errors) {
  const matches = [
    ...code.matchAll(
      new RegExp(`^\\s*(?:const\\s+)?${goName}\\s*=\\s*(.*?)\\s*$`, 'gm'),
    ),
  ];
  if (matches.length !== 1) {
    errors.push(
      `${goName} must have exactly one declaration in ${limitsSourceRelative}; found ${matches.length}`,
    );
    return undefined;
  }
  const expression = matches[0][1].trim();
  if (!/^(0|[1-9]\d*)$/.test(expression)) {
    errors.push(
      `${goName} must be a plain base-10 integer without a leading zero in ${limitsSourceRelative}; got ${JSON.stringify(expression)}`,
    );
    return undefined;
  }
  const value = Number(expression);
  if (!Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${goName} must be a positive safe integer; got ${expression}`);
    return undefined;
  }
  return value;
}

const GO_DURATION_UNITS = {
  Nanosecond: 1,
  Microsecond: 1_000,
  Millisecond: 1_000_000,
  Second: 1_000_000_000,
  Minute: 60_000_000_000,
  Hour: 3_600_000_000_000,
};

function parseGoDurationConstant(expression, label, errors) {
  const normalized = expression.replace(/\s+/g, '');
  const match = normalized.match(
    /^(?:(0|[1-9]\d*)\*)?time\.(Nanosecond|Microsecond|Millisecond|Second|Minute|Hour)(?:\*(0|[1-9]\d*))?$/,
  );
  if (!match || (match[1] !== undefined && match[3] !== undefined)) {
    errors.push(
      `${label} must be an integer multiple of a time.Duration unit; got ${JSON.stringify(expression.trim())}`,
    );
    return undefined;
  }
  const factor = Number(match[1] ?? match[3] ?? '1');
  const value = factor * GO_DURATION_UNITS[match[2]];
  if (!Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${label} is not a positive safe nanosecond duration`);
    return undefined;
  }
  return value;
}

function parseStopGraceLimits(code, errors) {
  const comparisons = [
    ...code.matchAll(/^\s*if\s+d\s*([<>])\s*([^{}]+?)\s*\{\s*$/gm),
  ];
  const lower = comparisons.filter((match) => match[1] === '<');
  const upper = comparisons.filter((match) => match[1] === '>');
  if (lower.length !== 1 || upper.length !== 1) {
    errors.push(
      `stop_grace_period bounds must have one "d < ..." and one "d > ..." comparison; found ${lower.length}/${upper.length}`,
    );
    return undefined;
  }
  const minStopGracePeriodNanoseconds = parseGoDurationConstant(
    lower[0][2],
    'minimum stop_grace_period',
    errors,
  );
  const maxStopGracePeriodNanoseconds = parseGoDurationConstant(
    upper[0][2],
    'maximum stop_grace_period',
    errors,
  );
  if (
    minStopGracePeriodNanoseconds === undefined ||
    maxStopGracePeriodNanoseconds === undefined
  ) {
    return undefined;
  }
  return { minStopGracePeriodNanoseconds, maxStopGracePeriodNanoseconds };
}

export function parseGoLimits(source, errors) {
  const code = stripGoNonCode(source);
  const declaredLimitNames = new Set(
    [...code.matchAll(/^\s*(?:const\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)]
      .map((match) => match[1])
      .filter(
        (name) =>
          /^(?:Max|max)[A-Z]/.test(name) ||
          /[a-z]Max[A-Z]/.test(name) ||
          /(?:Limit|Depth)$/.test(name),
      ),
  );
  const knownLimitNames = new Set(Object.values(GO_LIMITS));
  const unknownLimitNames = [...declaredLimitNames].filter(
    (name) => !knownLimitNames.has(name),
  );
  if (unknownLimitNames.length > 0) {
    errors.push(
      `untracked Fred limit-like constants in ${limitsSourceRelative}: ${unknownLimitNames.join(', ')}`,
    );
  }

  const limits = {};
  for (const [key, goName] of Object.entries(GO_LIMITS)) {
    const value = parsePlainIntegerDeclaration(code, goName, errors);
    if (value !== undefined) limits[key] = value;
  }
  const stopGraceLimits = parseStopGraceLimits(code, errors);
  if (stopGraceLimits) Object.assign(limits, stopGraceLimits);

  const expectedKeys = Object.keys(GO_LIMITS).length + 2;
  return Object.keys(limits).length === expectedKeys && errors.length === 0
    ? limits
    : undefined;
}

export function validateRecordedLimits(limits, errors) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    errors.push('provenance limits must be an object');
    return undefined;
  }
  const normalized = {};
  for (const key of GENERATED_LIMIT_KEYS) {
    const value = limits[key];
    if (!Number.isInteger(value) || value <= 0) {
      errors.push(`provenance limits.${key} must be a positive integer`);
    } else {
      normalized[key] = value;
    }
  }
  const unknown = Object.keys(limits).filter(
    (key) => !GENERATED_LIMIT_KEYS.includes(key),
  );
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

export function validateSchemaGoAlignment(schemaBytes, limits, errors) {
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
  const integerStopGrace = schema?.$defs?.StopGracePeriod?.oneOf?.find(
    (branch) => branch?.type === 'integer',
  );
  if (
    integerStopGrace?.minimum !== limits.minStopGracePeriodNanoseconds ||
    integerStopGrace?.maximum !== limits.maxStopGracePeriodNanoseconds
  ) {
    errors.push(
      `schema integer stop_grace_period bounds are ${String(integerStopGrace?.minimum)}..${String(integerStopGrace?.maximum)}, but pinned Fred uses ${limits.minStopGracePeriodNanoseconds}..${limits.maxStopGracePeriodNanoseconds}`,
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

export function compareBytes(actualPath, expected, label, errors) {
  if (!existsSync(actualPath)) {
    errors.push(`${label} is missing; run npm run sync:fred-manifest-schema`);
    return;
  }
  const actual = readBytes(actualPath, label, errors);
  if (actual && !actual.equals(expected)) {
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

  const sourceBytes = readBytes(sourcePath, sourceRelative, errors);
  const limitsSource = readText(limitsSourcePath, limitsSourceRelative, errors);
  if (!sourceBytes || limitsSource === undefined) return;
  const limits = parseGoLimits(limitsSource, errors);
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
        generator: { ajv: AJV_VERSION },
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

export function check(
  indexedFredCommit,
  errors,
  {
    readCheckedOutFredCommit = (targetErrors) =>
      tryGit(
        ['-C', resolve(repoRoot, 'submodules/fred'), 'rev-parse', 'HEAD'],
        targetErrors,
        'read the checked-out Fred commit',
      ),
    paths = {},
  } = {},
) {
  // Injectable paths let the decision tests corrupt isolated fixtures and
  // prove every comparison fails closed without touching repository files.
  const checkVendoredPath = paths.vendoredPath ?? vendoredPath;
  const checkProvenancePath = paths.provenancePath ?? provenancePath;
  const checkGeneratedValidatorPath =
    paths.generatedValidatorPath ?? generatedValidatorPath;
  const checkGeneratedLimitsPath =
    paths.generatedLimitsPath ?? generatedLimitsPath;
  const checkSourcePath = paths.sourcePath ?? sourcePath;
  const checkLimitsSourcePath = paths.limitsSourcePath ?? limitsSourcePath;

  if (!existsSync(checkVendoredPath) || !existsSync(checkProvenancePath)) {
    errors.push(
      'vendored schema or provenance is missing; run npm run sync:fred-manifest-schema',
    );
    return;
  }

  const vendoredBytes = readBytes(checkVendoredPath, 'vendored schema', errors);
  const provenanceValue = readJson(
    checkProvenancePath,
    'schema provenance',
    errors,
  );
  if (vendoredBytes === undefined || provenanceValue === undefined) return;
  const provenance = validateProvenanceShape(provenanceValue, errors);
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
  if (provenance.generator?.ajv !== AJV_VERSION) {
    errors.push(
      `generated validator records Ajv ${String(provenance.generator?.ajv)}, but the sync tool is using Ajv ${AJV_VERSION}; run npm run sync:fred-manifest-schema intentionally after reviewing the generator diff`,
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
      checkGeneratedValidatorPath,
      validatorBytes,
      'generated Fred schema validator',
      errors,
    );
  }
  if (limits) {
    compareBytes(
      checkGeneratedLimitsPath,
      generateLimitsModule(limits),
      'generated Fred manifest limits',
      errors,
    );
  }

  // Regular CI intentionally checks out without submodules. The gitlink,
  // digest, generated-validator, and generated-limit checks above still fail
  // closed there. With a Fred checkout, also prove the source bytes, Go caps,
  // and checked-out commit all match the gitlink.
  if (existsSync(checkSourcePath) || existsSync(checkLimitsSourcePath)) {
    if (!existsSync(checkSourcePath) || !existsSync(checkLimitsSourcePath)) {
      errors.push(
        'the Fred submodule checkout is partial: schema and manifest.go must either both exist or both be absent',
      );
      return;
    }
    const checkedOutFredCommit = readCheckedOutFredCommit(errors);
    if (checkedOutFredCommit && checkedOutFredCommit !== indexedFredCommit) {
      errors.push(
        `Fred checkout ${checkedOutFredCommit} does not match gitlink ${indexedFredCommit}`,
      );
    }
    const sourceBytes = readBytes(checkSourcePath, sourceRelative, errors);
    const limitsSource = readText(
      checkLimitsSourcePath,
      limitsSourceRelative,
      errors,
    );
    if (!sourceBytes || limitsSource === undefined) return;
    if (!sourceBytes.equals(vendoredBytes)) {
      errors.push(
        'vendored schema differs from the pinned Fred source; run npm run sync:fred-manifest-schema',
      );
    }
    const sourceLimitErrors = [];
    const sourceLimits = parseGoLimits(limitsSource, sourceLimitErrors);
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

export function main(argv = process.argv.slice(2)) {
  const errors = [];
  try {
    const indexedFredCommit = tryGit(
      ['rev-parse', ':submodules/fred'],
      errors,
      'read the submodules/fred gitlink',
    );
    if (indexedFredCommit) {
      if (argv.includes('--check')) check(indexedFredCommit, errors);
      else sync(indexedFredCommit, errors);
    }
  } catch (error) {
    errors.push(
      `unexpected sync failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return finish(errors);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
