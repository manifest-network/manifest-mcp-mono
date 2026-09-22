import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assertVerifiedProvenance } from '../tools/npm-provenance.mjs';
import {
  assertVerifierVersion,
  candidateAuditManifest,
  consumerDirectories,
  provenanceExpectations,
  verifyDirectory,
} from './check-dependency-provenance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const evidence = readJson('docs/dependency-repair-2026-09-21.json');
const lock = readJson('package-lock.json');
const fixture = readJson('scripts/fixtures/sdk-0.22.0-provenance.json');

function candidateFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'manifest-candidate-audit-'));
  const version = readJson('package.json').version;
  const core = readJson('packages/core/package.json').name;
  const fred = readJson('packages/fred/package.json').name;
  const sdk = readJson('packages/sdk/package.json').name;
  const manifest = {
    name: 'unpublished-candidate-consumer',
    version: '1.0.0',
    private: true,
    dependencies: {},
  };
  const candidateLock = { lockfileVersion: 3, packages: {} };
  const paths = new Map();
  const writeInstalled = (location, metadata) => {
    const path = join(directory, location);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify(metadata));
  };
  const addLocal = (name, installedVersion = version, edges = {}) => {
    const relative = `tarballs/candidate-${paths.size}.tgz`;
    const path = join(directory, relative);
    mkdirSync(join(directory, 'tarballs'), { recursive: true });
    // The selection boundary checks artifact bytes and installed identities;
    // packing/building the real runtime belongs to the consumer integration gate.
    const bytes = Buffer.from(`candidate artifact ${name}@${installedVersion}`);
    writeFileSync(path, bytes);
    paths.set(name, path);
    manifest.dependencies[name] = `file:${path}`;
    candidateLock.packages[`node_modules/${name}`] = {
      version: installedVersion,
      resolved: `file:${relative}`,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      ...edges,
    };
    writeInstalled(`node_modules/${name}`, {
      name,
      version: installedVersion,
      ...edges,
    });
  };
  addLocal(core);
  addLocal(fred, version, { peerDependencies: { [core]: `^${version}` } });
  addLocal(sdk, version, {
    dependencies: { [core]: version, [fred]: version },
  });

  // Sharing the repository scope (or even a workspace package name) does not
  // make an actually published installation an unpublished local candidate.
  const publicName = readJson('packages/chain/package.json').name;
  manifest.dependencies[publicName] = '0.22.0';
  candidateLock.packages[`node_modules/${publicName}`] = {
    version: '0.22.0',
    resolved: `https://registry.npmjs.org/${publicName}/-/manifest-mcp-chain-0.22.0.tgz`,
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  };
  writeInstalled(`node_modules/${publicName}`, {
    name: publicName,
    version: '0.22.0',
  });
  const save = () => {
    candidateLock.packages[''] = structuredClone(manifest);
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    writeFileSync(
      join(directory, 'package-lock.json'),
      JSON.stringify(candidateLock),
    );
  };
  save();
  return {
    directory,
    version,
    core,
    fred,
    sdk,
    publicName,
    manifest,
    lock: candidateLock,
    paths,
    addLocal,
    writeInstalled,
    save,
  };
}

test('candidate signature-audit manifest preserves unpublished exact and peer edges without overriding public artifacts', () => {
  const current = candidateFixture();
  try {
    const originals = [
      'package.json',
      'package-lock.json',
      ...Object.keys(current.lock.packages)
        .filter((location) => location !== '')
        .map((location) => `${location}/package.json`),
    ].map((path) => [
      path,
      readFileSync(join(current.directory, path), 'utf8'),
    ]);
    const originalLock = structuredClone(current.lock);
    const result = candidateAuditManifest(current.directory, current.lock);
    assert.deepEqual(result, {
      ...current.manifest,
      overrides: Object.fromEntries(
        [current.core, current.fred, current.sdk].map((name) => [
          name,
          `$${name}`,
        ]),
      ),
    });
    assert.equal(result.overrides[current.publicName], undefined);
    assert.deepEqual(current.lock, originalLock);
    // A caller may serialize or modify the returned audit-only manifest, but
    // selection must never edit the tested consumer or its installed packages.
    result.dependencies[current.core] = 'changed-after-selection';
    for (const [path, contents] of originals)
      assert.equal(
        readFileSync(join(current.directory, path), 'utf8'),
        contents,
        path,
      );
  } finally {
    rmSync(current.directory, { recursive: true, force: true });
  }
});

test('registry-only consumers need no candidate audit manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manifest-public-audit-'));
  try {
    const manifest = {
      private: true,
      dependencies: { '@manifest-network/manifestjs': '4.0.0' },
    };
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    assert.equal(candidateAuditManifest(directory, { packages: {} }), null);
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')),
      manifest,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('candidate audit overrides reject artifact, identity and resolution substitutions', async (t) => {
  const cases = [
    [
      'changed tarball bytes',
      (current) => {
        writeFileSync(current.paths.get(current.fred), 'different artifact');
      },
    ],
    [
      'changed locked integrity',
      (current) => {
        current.lock.packages[`node_modules/${current.fred}`].integrity =
          `sha512-${Buffer.alloc(64).toString('base64')}`;
      },
    ],
    [
      'changed locked version',
      (current) => {
        current.lock.packages[`node_modules/${current.fred}`].version +=
          '-unreviewed';
      },
    ],
    [
      'changed installed version',
      (current) => {
        current.writeInstalled(`node_modules/${current.fred}`, {
          name: current.fred,
          version: `${current.version}-unreviewed`,
        });
      },
    ],
    [
      'changed installed name',
      (current) => {
        current.writeInstalled(`node_modules/${current.fred}`, {
          name: '@manifest-network/impostor',
          version: current.version,
        });
      },
    ],
    [
      'registry fallback for a local candidate',
      (current) => {
        current.lock.packages[`node_modules/${current.fred}`].resolved =
          `https://registry.npmjs.org/${current.fred}/-/manifest-mcp-fred-${current.version}.tgz`;
      },
    ],
    [
      'different root and locked tarballs',
      (current) => {
        current.manifest.dependencies[current.fred] =
          `file:${current.paths.get(current.core)}`;
      },
    ],
    [
      'duplicate nested candidate',
      (current) => {
        const location = `node_modules/nested/node_modules/${current.fred}`;
        current.lock.packages[location] = {
          ...current.lock.packages[`node_modules/${current.fred}`],
        };
        current.writeInstalled(location, {
          name: current.fred,
          version: current.version,
        });
      },
    ],
    [
      'candidate installed under an alias',
      (current) => {
        const location = 'node_modules/candidate-alias';
        current.lock.packages[location] = {
          ...current.lock.packages[`node_modules/${current.fred}`],
          name: current.fred,
        };
        delete current.lock.packages[`node_modules/${current.fred}`];
        current.writeInstalled(location, {
          name: current.fred,
          version: current.version,
        });
      },
    ],
    [
      'maintained fork presented as a local candidate',
      (current) => {
        current.addLocal('@manifest-network/manifestjs', '4.0.0');
      },
    ],
    [
      'unknown scoped package presented as a local candidate',
      (current) => {
        current.addLocal('@manifest-network/unreviewed-candidate');
      },
    ],
    ...['devDependencies', 'optionalDependencies', 'peerDependencies'].map(
      (section) => [
        `competing candidate in ${section}`,
        (current) => {
          current.manifest[section] = { [current.fred]: current.version };
        },
      ],
    ),
    [
      'existing application overrides',
      (current) => {
        current.manifest.overrides = { axios: '1.19.0' };
      },
    ],
  ];
  for (const [name, change] of cases) {
    await t.test(name, () => {
      const current = candidateFixture();
      try {
        change(current);
        current.save();
        const before = readFileSync(
          join(current.directory, 'package.json'),
          'utf8',
        );
        const originalLock = structuredClone(current.lock);
        assert.throws(() =>
          candidateAuditManifest(current.directory, current.lock),
        );
        assert.equal(
          readFileSync(join(current.directory, 'package.json'), 'utf8'),
          before,
        );
        assert.deepEqual(current.lock, originalLock);
      } finally {
        rmSync(current.directory, { recursive: true, force: true });
      }
    });
  }
});

test('provenance requires the reviewed npm verifier version and successful invocation', () => {
  assertVerifierVersion({ status: 0, stdout: '11.19.1\n', stderr: '' });
  for (const [status, stdout] of [
    [0, '11.12.1'],
    [0, '11.20.0'],
    [1, '11.19.1'],
  ]) {
    assert.throws(() => assertVerifierVersion({ status, stdout, stderr: '' }));
  }
});

test('review record binds all four actual locked fork artifacts to reviewed source identities', () => {
  assert.equal(provenanceExpectations(evidence, lock).length, 4);
  for (const change of [
    (record) => {
      record.packages.pop();
    },
    (record) => {
      record.packages.push(record.packages[0]);
    },
    (record) => {
      record.packages[0].source.repository = 'attacker/repo';
    },
    (record) => {
      record.packages[0].source.workflow = '.github/workflows/unreviewed.yml';
    },
    (record) => {
      record.packages[0].source.ref = 'refs/heads/feature';
    },
    (record) => {
      record.packages[0].source.sha = 'main';
    },
    (record) => {
      record.packages[0].version += '-unreviewed';
    },
    (record) => {
      record.packages[0].integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
    },
  ]) {
    const changed = structuredClone(evidence);
    change(changed);
    assert.throws(() => provenanceExpectations(changed, lock));
  }
  const changed = structuredClone(lock);
  changed.packages['node_modules/nested/node_modules/@cosmology/lcd'] = {
    ...changed.packages['node_modules/@cosmology/lcd'],
    version: `${changed.packages['node_modules/@cosmology/lcd'].version}-unreviewed`,
  };
  assert.throws(
    () => provenanceExpectations(evidence, changed),
    /Unreviewed dependency version/,
  );
});

test('each fork accepts only its repository release branch', () => {
  const expectations = provenanceExpectations(evidence, lock);
  for (const [names, allowed, rejected] of [
    [
      ['@manifest-network/ics23', '@manifest-network/stargate'],
      'refs/heads/manifest/0.32',
      'refs/heads/main',
    ],
    [
      ['@manifest-network/lcd', '@manifest-network/manifestjs'],
      'refs/heads/main',
      'refs/heads/manifest/0.32',
    ],
  ]) {
    for (const name of names) {
      assert.equal(
        expectations.find((entry) => entry.name === name).ref,
        allowed,
      );
      const changed = structuredClone(evidence);
      changed.packages.find((entry) => entry.name === name).source.ref =
        rejected;
      assert.throws(
        () => provenanceExpectations(changed, lock),
        /Unexpected trusted source policy/,
        `${name} must reject ${rejected}`,
      );
    }
  }
});

test('offline policy fixtures accept known verified bundle bytes and reject identity/digest substitutions', () => {
  // Public SDK fixture was independently verified with npm audit signatures.
  // This offline test checks policy/schema, not fresh cryptographic verification.
  const audit = { invalid: [], missing: [], verified: [fixture.verified] };
  assert.equal(assertVerifiedProvenance(audit, fixture.expected).length, 1);
  for (const changed of [
    { repository: 'attacker/repo' },
    { workflow: '.github/workflows/other.yml' },
    { ref: 'refs/heads/feature' },
    { sha: 'f'.repeat(40) },
    { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` },
    { version: '0.0.0' },
  ])
    assert.throws(() =>
      assertVerifiedProvenance(audit, { ...fixture.expected, ...changed }),
    );
  for (const change of [
    (report) => {
      report.invalid = [{}];
    },
    (report) => {
      report.missing = [{}];
    },
    (report) => {
      report.verified = [];
    },
    (report) => {
      report.verified[0].attestationBundles = [];
    },
    (report) => {
      report.verified[0].attestationBundles.push(
        report.verified[0].attestationBundles[0],
      );
    },
    (report) => {
      report.verified[0].registry = 'https://attacker.invalid/';
    },
    (report) => {
      report.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload =
        Buffer.from('{}').toString('base64');
    },
    (report) => {
      report.verified[0].attestationBundles[0].bundle.verificationMaterial = {};
    },
  ]) {
    const changed = structuredClone(audit);
    change(changed);
    assert.throws(() => assertVerifiedProvenance(changed, fixture.expected));
  }
});

test('historical manual publications and current artifacts have no provenance exception', () => {
  // These exact legacy artifacts were manually published without attestations.
  // Their recorded source commits are claims, not verified source identities.
  const historicalArtifacts = {
    '@manifest-network/lcd': {
      version: '0.14.6',
      integrity:
        'sha512-DN8B5ZBJloYyndToPjzG1RGVvzcHkHFTX7L/5tqfTB6tDzd/jQkdqqBMm/lAWS08bQCNRrjF6TllTzFll4z+lw==',
      sha: '5df11dcf6c41db000355ab0214c7ee091392a972',
    },
    '@manifest-network/ics23': {
      version: '0.6.9',
      integrity:
        'sha512-SrxZiZt6JPxoFfAwa8UytlIp8ttBb3e3mauhZtldU14CZCDPDYXFjNTknS0DGbmQk/Sk4vSWEdlD1aNcbecDXQ==',
      sha: 'd9ec2a47735d252fdda90f7aaeddd8eec4d3cee7',
    },
    '@manifest-network/stargate': {
      version: '0.32.4-ll.4',
      integrity:
        'sha512-tFe6rjukHDAIJQvxew2hZc/srQ6buTrPKFThIvJp+MxZ64XMs7fHr1UF+q9Sj8WNT5YNw/pEnoMBMK/4Y4sA+Q==',
      sha: 'd9ec2a47735d252fdda90f7aaeddd8eec4d3cee7',
    },
    '@manifest-network/manifestjs': {
      version: '3.0.1',
      integrity:
        'sha512-0yxioP3C3OftE+EvLBqsHOGl190329a3dv8dKbb32vEWFpRZdSLzxvSzpAklL7H/GiRYnnHyHM00IXpLFhmckQ==',
      sha: '5df11dcf6c41db000355ab0214c7ee091392a972',
    },
  };
  const current = provenanceExpectations(evidence, lock);
  const historical = current.map((expected) => ({
    ...expected,
    ...historicalArtifacts[expected.name],
  }));
  for (const expected of [...historical, ...current]) {
    assert.throws(
      () =>
        assertVerifiedProvenance(
          {
            invalid: [],
            missing: [],
            verified: [
              {
                name: expected.name,
                version: expected.version,
                registry: 'https://registry.npmjs.org/',
                attestationBundles: [],
              },
            ],
          },
          expected,
        ),
      /cryptographically verified provenance bundle/,
    );
  }
});

test('failed cryptographic verification cannot become a policy pass from its JSON output', {
  skip: process.platform === 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'manifest-verifier-failure-'));
  const originalPath = process.env.PATH;
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ private: true }),
    );
    writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(lock));
    const command = join(directory, 'npm');
    writeFileSync(
      command,
      `#!${process.execPath}\nif (process.argv[2] === '--version') { console.log('11.19.1'); } else { console.log(JSON.stringify({invalid: [], missing: [], verified: []})); process.exitCode = 1; }\n`,
    );
    chmodSync(command, 0o755);
    process.env.PATH = `${directory}:${originalPath}`;
    const report = join(directory, 'signatures.json');
    assert.throws(
      () =>
        verifyDirectory(directory, evidence, join(directory, 'cache'), report),
      /Verify npm signatures in/,
    );
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), {
      invalid: [],
      missing: [],
      verified: [],
    });
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('consumer provenance matrix refuses missing, ambiguous or failing consumer evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manifest-provenance-matrix-'));
  try {
    assert.throws(() => consumerDirectories(directory), /exactly one/);
    const run = join(directory, 'run-fixture');
    mkdirSync(run);
    const summary = [
      '@manifest-network/manifest-sdk',
      '@manifest-network/manifest-mcp-node',
    ].map((target) => ({ target, passes: true }));
    const write = (value) =>
      writeFileSync(join(run, 'summary.json'), JSON.stringify(value));
    write(summary);
    assert.deepEqual(consumerDirectories(directory), [
      join(run, 'sdk'),
      join(run, 'node'),
    ]);
    write(summary.slice(1));
    assert.throws(() => consumerDirectories(directory));
    write([{ ...summary[0], passes: false }, summary[1]]);
    assert.throws(() => consumerDirectories(directory), /must pass first/);
    write(summary);
    mkdirSync(join(directory, 'run-stale'));
    assert.throws(() => consumerDirectories(directory), /exactly one/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release verifies cryptographic provenance after fresh consumers; ordinary PR CI runs offline regression tests', () => {
  const release = parse(
    readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'),
  );
  const steps = release.jobs.validate.steps;
  const check = steps.findIndex(({ run }) =>
    run?.includes('npm run check:dependency-provenance'),
  );
  assert.ok(
    check >
      steps.findIndex(({ run }) => run?.includes('npm run check:consumers')),
  );
  assert.equal(
    steps[check].run,
    'npm run check:dependency-provenance -- --consumers "$RUNNER_TEMP/manifest-consumers"',
  );
  assert.equal(steps[check].if, undefined);
  assert.equal(steps[check]['continue-on-error'], undefined);
  assert.equal(release.jobs.release.needs, 'validate');
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /npm run check:dependency-provenance/);
  assert.match(
    readJson('package.json').scripts['check:review-tooling'],
    /scripts\/check-dependency-provenance\.test\.mjs/,
  );
});
