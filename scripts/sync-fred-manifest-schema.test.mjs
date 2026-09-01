import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  check,
  compareBytes,
  finish,
  parseGoLimits,
  stripGoNonCode,
  validateProvenanceShape,
  validateRecordedLimits,
  validateSchemaGoAlignment,
} from './sync-fred-manifest-schema.mjs';

const VALID_GO_SOURCE = `
package manifest

const MaxTmpfsMounts = 4
const (
  MaxPorts = 64
  MaxExposePorts = 64
  MaxEnvVars = 256
  MaxLabels = 128
)
const dependsOnMaxDepth = 10

func validateStop(d time.Duration) error {
  if d < time.Second {
    return errTooShort
  }
  if d > 120 * time.Second {
    return errTooLong
  }
  return nil
}
`;

const VALID_LIMITS = {
  maxTmpfsMounts: 4,
  maxPorts: 64,
  maxExposePorts: 64,
  maxEnvVars: 256,
  maxLabels: 128,
  dependsOnMaxDepth: 10,
  minStopGracePeriodNanoseconds: 1_000_000_000,
  maxStopGracePeriodNanoseconds: 120_000_000_000,
};

function runCheckAgainstFixture(mutate, checkedOutCommit) {
  const directory = mkdtempSync(join(tmpdir(), 'fred-schema-check-'));
  const provenance = JSON.parse(
    readFileSync(
      join('packages', 'fred', 'schema', 'manifest-schema.source.json'),
      'utf8',
    ),
  );
  const paths = {
    vendoredPath: join(directory, 'manifest-schema.json'),
    provenancePath: join(directory, 'manifest-schema.source.json'),
    generatedValidatorPath: join(directory, 'validator.ts'),
    generatedLimitsPath: join(directory, 'limits.ts'),
    sourcePath: join(directory, 'source-schema.json'),
    limitsSourcePath: join(directory, 'manifest.go'),
  };

  try {
    copyFileSync(
      join('packages', 'fred', 'schema', 'manifest-schema.json'),
      paths.vendoredPath,
    );
    copyFileSync(
      join('packages', 'fred', 'schema', 'manifest-schema.source.json'),
      paths.provenancePath,
    );
    copyFileSync(
      join(
        'packages',
        'fred',
        'src',
        'generated',
        'fred-manifest-schema-validator.ts',
      ),
      paths.generatedValidatorPath,
    );
    copyFileSync(
      join('packages', 'fred', 'src', 'generated', 'fred-manifest-limits.ts'),
      paths.generatedLimitsPath,
    );
    copyFileSync(paths.vendoredPath, paths.sourcePath);
    writeFileSync(paths.limitsSourcePath, VALID_GO_SOURCE);

    mutate({ paths, provenance });
    const errors = [];
    check(provenance.fredCommit, errors, {
      paths,
      readCheckedOutFredCommit: () => checkedOutCommit ?? provenance.fredCommit,
    });
    return errors;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Fred manifest Go-limit parser', () => {
  it('extracts named caps, dependency depth, and inline duration bounds', () => {
    const errors = [];
    assert.deepEqual(parseGoLimits(VALID_GO_SOURCE, errors), {
      maxTmpfsMounts: 4,
      maxPorts: 64,
      maxExposePorts: 64,
      maxEnvVars: 256,
      maxLabels: 128,
      dependsOnMaxDepth: 10,
      minStopGracePeriodNanoseconds: 1_000_000_000,
      maxStopGracePeriodNanoseconds: 120_000_000_000,
    });
    assert.deepEqual(errors, []);
  });

  it('ignores declaration-shaped text in comments and quoted literals', () => {
    const poisoned = VALID_GO_SOURCE.replace(
      'const MaxPorts = 64',
      `// Historically MaxPorts = 32
  const MaxPorts = 64
  const note = \`MaxPorts = 16\`
  const other = "MaxPorts = 8"`,
    );
    const errors = [];
    assert.equal(parseGoLimits(poisoned, errors)?.maxPorts, 64);
    assert.deepEqual(errors, []);
  });

  it('rejects expressions instead of recording their first integer', () => {
    const errors = [];
    assert.equal(
      parseGoLimits(
        VALID_GO_SOURCE.replace('MaxPorts = 64', 'MaxPorts = 128 / 2'),
        errors,
      ),
      undefined,
    );
    assert.match(errors.join('\n'), /MaxPorts must be a plain base-10 integer/);
  });

  it('rejects a leading-zero Go integer instead of reading it as decimal', () => {
    const errors = [];
    assert.equal(
      parseGoLimits(
        VALID_GO_SOURCE.replace('MaxPorts = 64', 'MaxPorts = 0100'),
        errors,
      ),
      undefined,
    );
    assert.match(errors.join('\n'), /without a leading zero/);
  });

  it('rejects duplicate declarations and newly introduced Max constants', () => {
    const errors = [];
    assert.equal(
      parseGoLimits(
        `${VALID_GO_SOURCE}\nconst MaxPorts = 32\nconst MaxServices = 8\n`,
        errors,
      ),
      undefined,
    );
    assert.match(
      errors.join('\n'),
      /MaxPorts must have exactly one declaration/,
    );
    assert.match(
      errors.join('\n'),
      /untracked Fred limit-like constants.*MaxServices/,
    );
  });

  it('rejects newly introduced unexported limit-like constants', () => {
    const errors = [];
    assert.equal(
      parseGoLimits(
        `${VALID_GO_SOURCE}\nconst serviceMaxDepth = 12\nconst maxServices = 20\n`,
        errors,
      ),
      undefined,
    );
    assert.match(
      errors.join('\n'),
      /untracked Fred limit-like constants.*serviceMaxDepth/,
    );
    assert.match(errors.join('\n'), /maxServices/);
  });

  it('rejects leading-zero duration factors that Go interprets as octal', () => {
    const errors = [];
    assert.equal(
      parseGoLimits(
        VALID_GO_SOURCE.replace('120 * time.Second', '0120 * time.Second'),
        errors,
      ),
      undefined,
    );
    assert.match(errors.join('\n'), /integer multiple of a time.Duration unit/);
  });

  it('preserves newlines while removing block comments and raw strings', () => {
    const source = '/*\nMaxPorts = 32\n*/\n`\nMaxPorts = 16\n`';
    const stripped = stripGoNonCode(source);
    assert.equal(stripped.split('\n').length, source.split('\n').length);
    assert.doesNotMatch(stripped, /MaxPorts/);
  });
});

describe('Fred manifest provenance shape', () => {
  for (const value of [null, false, 0, '', []]) {
    it(`rejects parsed non-object provenance ${JSON.stringify(value)}`, () => {
      const errors = [];
      assert.equal(validateProvenanceShape(value, errors), undefined);
      assert.deepEqual(errors, ['schema provenance must be a JSON object']);
    });
  }

  it('accepts an object provenance record', () => {
    const errors = [];
    const value = { source: 'schema.json' };
    assert.equal(validateProvenanceShape(value, errors), value);
    assert.deepEqual(errors, []);
  });
});

describe('Fred manifest gate decisions', () => {
  it('validates every recorded limit and rejects missing or unknown keys', () => {
    const validErrors = [];
    assert.deepEqual(
      validateRecordedLimits(VALID_LIMITS, validErrors),
      VALID_LIMITS,
    );
    assert.deepEqual(validErrors, []);

    const errors = [];
    assert.equal(
      validateRecordedLimits(
        { ...VALID_LIMITS, maxPorts: undefined, surpriseLimit: 1 },
        errors,
      ),
      undefined,
    );
    assert.match(
      errors.join('\n'),
      /limits\.maxPorts must be a positive integer/,
    );
    assert.match(errors.join('\n'), /unknown keys: surpriseLimit/);
  });

  it('cross-checks schema-backed Go limits', () => {
    const schema = Buffer.from(
      JSON.stringify({
        $defs: {
          DockerManifestBase: {
            properties: { tmpfs: { maxItems: 4 } },
          },
          StopGracePeriod: {
            oneOf: [
              {
                type: 'integer',
                minimum: 1_000_000_000,
                maximum: 120_000_000_000,
              },
            ],
          },
        },
      }),
    );
    const validErrors = [];
    validateSchemaGoAlignment(schema, VALID_LIMITS, validErrors);
    assert.deepEqual(validErrors, []);

    const errors = [];
    validateSchemaGoAlignment(
      schema,
      { ...VALID_LIMITS, maxTmpfsMounts: 5 },
      errors,
    );
    assert.match(errors.join('\n'), /tmpfs\.maxItems.*MaxTmpfsMounts/);
  });

  it('detects missing, stale, equal, and unreadable generated artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fred-schema-gate-'));
    try {
      const artifact = join(directory, 'artifact.ts');
      const expected = Buffer.from('expected\n');

      const missingErrors = [];
      compareBytes(artifact, expected, 'artifact', missingErrors);
      assert.match(missingErrors.join('\n'), /artifact is missing/);

      writeFileSync(artifact, expected);
      const equalErrors = [];
      compareBytes(artifact, expected, 'artifact', equalErrors);
      assert.deepEqual(equalErrors, []);

      writeFileSync(artifact, 'stale\n');
      const staleErrors = [];
      compareBytes(artifact, expected, 'artifact', staleErrors);
      assert.match(staleErrors.join('\n'), /artifact is stale/);

      const unreadableErrors = [];
      compareBytes(directory, expected, 'artifact directory', unreadableErrors);
      assert.match(
        unreadableErrors.join('\n'),
        /cannot read artifact directory/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('sets a failing exit code and emits every collected diagnostic', () => {
    let output = '';
    let exitCode;
    assert.equal(
      finish(['first', 'second'], {
        writeError: (message) => {
          output += message;
        },
        setExitCode: (code) => {
          exitCode = code;
        },
      }),
      false,
    );
    assert.equal(exitCode, 1);
    assert.match(output, /fred manifest schema: first/);
    assert.match(output, /fred manifest schema: second/);
  });

  it('executes the full check decision against the indexed Fred contract', () => {
    const indexedFredCommit = JSON.parse(
      readFileSync(
        join('packages', 'fred', 'schema', 'manifest-schema.source.json'),
        'utf8',
      ),
    ).fredCommit;
    const errors = [];
    check(indexedFredCommit, errors, {
      readCheckedOutFredCommit: () => indexedFredCommit,
    });
    assert.deepEqual(errors, []);
  });

  const driftCases = [
    [
      'provenance source',
      ({ paths, provenance }) =>
        writeFileSync(
          paths.provenancePath,
          JSON.stringify({ ...provenance, source: 'wrong/schema.json' }),
        ),
      /provenance source must be/,
    ],
    [
      'limits source',
      ({ paths, provenance }) =>
        writeFileSync(
          paths.provenancePath,
          JSON.stringify({ ...provenance, limitsSource: 'wrong/manifest.go' }),
        ),
      /provenance limitsSource must be/,
    ],
    [
      'recorded Fred commit',
      ({ paths, provenance }) =>
        writeFileSync(
          paths.provenancePath,
          JSON.stringify({ ...provenance, fredCommit: '0'.repeat(40) }),
        ),
      /Fred gitlink moved/,
    ],
    [
      'Ajv generator version',
      ({ paths, provenance }) =>
        writeFileSync(
          paths.provenancePath,
          JSON.stringify({
            ...provenance,
            generator: { ajv: '0.0.0-test' },
          }),
        ),
      /generated validator records Ajv/,
    ],
    [
      'vendored schema digest',
      ({ paths }) => writeFileSync(paths.vendoredPath, '{}\n'),
      /vendored schema SHA-256/,
    ],
    [
      'schema-to-Go limit alignment',
      ({ paths, provenance }) =>
        writeFileSync(
          paths.provenancePath,
          JSON.stringify({
            ...provenance,
            limits: { ...provenance.limits, maxTmpfsMounts: 5 },
          }),
        ),
      /schema tmpfs\.maxItems/,
    ],
    [
      'generated validator bytes',
      ({ paths }) => writeFileSync(paths.generatedValidatorPath, 'stale\n'),
      /generated Fred schema validator is stale/,
    ],
    [
      'generated limits bytes',
      ({ paths }) => writeFileSync(paths.generatedLimitsPath, 'stale\n'),
      /generated Fred manifest limits is stale/,
    ],
    [
      'pinned schema bytes',
      ({ paths }) => writeFileSync(paths.sourcePath, '{}\n'),
      /vendored schema differs from the pinned Fred source/,
    ],
    [
      'pinned Go limits',
      ({ paths }) =>
        writeFileSync(
          paths.limitsSourcePath,
          VALID_GO_SOURCE.replace('MaxPorts = 64', 'MaxPorts = 63'),
        ),
      /recorded limits .* differ from pinned Fred/,
    ],
  ];

  for (const [name, mutate, diagnostic] of driftCases) {
    it(`fails the full check when ${name} drifts`, () => {
      const errors = runCheckAgainstFixture(mutate);
      assert.match(errors.join('\n'), diagnostic);
    });
  }

  it('fails the full check when the Fred checkout differs from the gitlink', () => {
    const errors = runCheckAgainstFixture(() => {}, 'f'.repeat(40));
    assert.match(errors.join('\n'), /Fred checkout .* does not match gitlink/);
  });
});
