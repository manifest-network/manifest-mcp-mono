import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseGoLimits,
  stripGoNonCode,
  validateProvenanceShape,
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
    assert.match(errors.join('\n'), /MaxPorts must be a plain decimal integer/);
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
      /untracked Fred Max\* constants.*MaxServices/,
    );
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
