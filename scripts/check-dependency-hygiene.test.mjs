import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { lockedPackageName } from '../tools/consumer-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const prWorkflow = parse(
  readFileSync(join(root, '.github/workflows/e2e-pr.yml'), 'utf8'),
);
const gate = prWorkflow.jobs['e2e-gate'];
const gateStep = gate.steps.find((step) => step.env?.ACCEPTANCE);

const dependencyEvidence = JSON.parse(
  readFileSync(join(root, 'docs/dependency-repair-2026-09-21.json'), 'utf8'),
);
const dependencyLock = JSON.parse(
  readFileSync(join(root, 'package-lock.json'), 'utf8'),
);

function assertRecordedDependencies(evidence, lock) {
  assert.deepEqual(evidence.packages.map(({ name }) => name).sort(), [
    '@manifest-network/ics23',
    '@manifest-network/lcd',
    '@manifest-network/manifestjs',
    '@manifest-network/stargate',
  ]);
  for (const record of evidence.packages) {
    const copies = Object.entries(lock.packages).filter(
      ([location, entry]) => lockedPackageName(location, entry) === record.name,
    );
    assert.ok(
      copies.length > 0,
      `Recorded dependency missing from lockfile: ${record.name}`,
    );
    for (const [location, installed] of copies) {
      for (const field of ['version', 'integrity']) {
        assert.equal(
          installed[field],
          record[field],
          `Dependency evidence ${field} mismatch: ${location}`,
        );
      }
      assert.equal(
        installed.resolved,
        record.tarball,
        `Dependency evidence tarball mismatch: ${location}`,
      );
      assert.deepEqual(
        installed.dependencies,
        record.dependencies,
        `Dependency evidence declarations mismatch: ${location}`,
      );
    }
  }
}

test('recorded dependency artifacts match every locked fork copy', () => {
  assertRecordedDependencies(dependencyEvidence, dependencyLock);
});

test('dependency evidence guard rejects drift, missing artifacts and nested version skew', () => {
  const location = 'node_modules/@confio/ics23';
  for (const mutate of [
    (lock) => {
      lock.packages[location].version = '0.6.10';
    },
    (lock) => {
      lock.packages[location].integrity = 'sha512-different-artifact';
    },
    (lock) => {
      lock.packages[location].resolved = 'https://example.invalid/ics23.tgz';
    },
    (lock) => {
      lock.packages[location].dependencies.protobufjs = '^6.8.8';
    },
    (lock) => {
      delete lock.packages[location];
    },
    (lock) => {
      lock.packages[`node_modules/nested/${location}`] = {
        ...lock.packages[location],
        version: '0.6.10',
      };
    },
  ]) {
    const changed = structuredClone(dependencyLock);
    mutate(changed);
    assert.throws(() =>
      assertRecordedDependencies(dependencyEvidence, changed),
    );
  }
  const empty = { ...dependencyEvidence, packages: [] };
  assert.throws(() => assertRecordedDependencies(empty, dependencyLock));
});

// Published CLIs own their runtime dependency graph. Shared libraries retain
// their compatibility ranges; workspace sibling policy is enforced separately.
function cliRuntimeRangeFailures(packages) {
  const internalNames = new Set(packages.map((pkg) => pkg.name));
  const failures = [];
  for (const pkg of packages) {
    if (pkg.private === true || !pkg.bin || Object.keys(pkg.bin).length === 0)
      continue;
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(pkg[section] ?? {})) {
        if (internalNames.has(name)) continue;
        // This is a range-policy check, not a replacement for npm's semver validation.
        if (
          !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
            version,
          )
        ) {
          failures.push(
            `${pkg.name} ${section}.${name} must use an exact registry version; received ${version}`,
          );
        }
      }
    }
  }
  return failures;
}

const workspacePackages = readdirSync(join(root, 'packages'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) =>
    JSON.parse(
      readFileSync(join(root, 'packages', entry.name, 'package.json'), 'utf8'),
    ),
  );

test('published CLI external runtime dependencies use exact versions', () => {
  assert(workspacePackages.some((pkg) => pkg.private !== true && pkg.bin));
  assert.deepEqual(cliRuntimeRangeFailures(workspacePackages), []);
});

test('CLI dependency policy rejects restored dotenv ranges and optional runtime ranges', () => {
  for (const version of ['^17.2.3', '~17.4.2', '>=17.4.2', 'latest']) {
    const mutated = structuredClone(workspacePackages);
    const node = mutated.find(
      (pkg) => pkg.name === '@manifest-network/manifest-mcp-node',
    );
    node.dependencies.dotenv = version;
    assert.deepEqual(cliRuntimeRangeFailures(mutated), [
      `${node.name} dependencies.dotenv must use an exact registry version; received ${version}`,
    ]);
  }
  const mutated = structuredClone(workspacePackages);
  const node = mutated.find(
    (pkg) => pkg.name === '@manifest-network/manifest-mcp-node',
  );
  node.optionalDependencies = { 'optional-runtime': '^1.2.3' };
  assert.deepEqual(cliRuntimeRangeFailures(mutated), [
    `${node.name} optionalDependencies.optional-runtime must use an exact registry version; received ^1.2.3`,
  ]);
});

test('CLI dependency policy leaves library, peer and development ranges alone', () => {
  const mutated = structuredClone(workspacePackages);
  const library = mutated.find((pkg) => pkg.private !== true && !pkg.bin);
  library.dependencies = {
    ...library.dependencies,
    'library-runtime': '^1.2.3',
  };
  const node = mutated.find(
    (pkg) => pkg.name === '@manifest-network/manifest-mcp-node',
  );
  node.peerDependencies = { peer: '^1.2.3' };
  node.devDependencies = {
    ...node.devDependencies,
    'development-tool': '^1.2.3',
  };
  assert.deepEqual(cliRuntimeRangeFailures(mutated), []);
});

test('E2E gate receives both the change decision and the live result on every PR', () => {
  assert.equal(gate.if, 'always()');
  assert.deepEqual(gate.needs, ['changes', 'acceptance-single']);
  assert.equal(gateStep.env.DEPLOY, `\${{ needs.changes.outputs.deploy }}`);
  assert.equal(gateStep.env.CHANGES, `\${{ needs.changes.result }}`);
  assert.equal(
    gateStep.env.ACCEPTANCE,
    `\${{ needs.acceptance-single.result }}`,
  );
  assert.equal(prWorkflow.on.pull_request, null);
});

for (const [changes, deploy, acceptance, passes] of [
  ['success', 'true', 'success', true],
  ['success', 'true', 'skipped', false],
  ['success', 'true', 'failure', false],
  ['success', 'true', 'cancelled', false],
  ['success', 'false', 'skipped', true],
  ['success', 'false', 'success', true],
  ['success', 'false', 'failure', false],
  ['success', 'false', 'cancelled', false],
  ['failure', 'false', 'skipped', false],
  ['cancelled', 'true', 'success', false],
  ['skipped', 'false', 'skipped', false],
  ['success', '', 'skipped', false],
  ['success', '', 'success', false],
  ['success', 'false', '', false],
  ['success', 'true', 'unknown', false],
]) {
  test(`E2E gate: changes=${changes}, deploy=${deploy}, acceptance=${acceptance}`, () => {
    const result = spawnSync('bash', ['-c', gateStep.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CHANGES: changes,
        DEPLOY: deploy,
        ACCEPTANCE: acceptance,
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, passes ? 0 : 1, result.stdout + result.stderr);
    if (deploy === 'true' && acceptance === 'skipped') {
      assert.match(result.stdout, /skipped run provides no coverage/);
      assert.match(result.stdout, /non-Dependabot PR/);
    }
  });
}

test('SDK validators work when tsdown cannot resolve them; each fallback fails', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'eng768-validators-'));
  try {
    mkdirSync(join(fixture, 'src'));
    symlinkSync(
      join(root, 'node_modules'),
      join(fixture, 'node_modules'),
      'dir',
    );
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({
        name: 'eng768-validator-fixture',
        version: '1.0.0',
        type: 'module',
        files: ['dist'],
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        },
      }),
    );
    writeFileSync(
      join(fixture, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { module: 'NodeNext', target: 'ES2020', strict: true },
        include: ['src'],
      }),
    );
    writeFileSync(join(fixture, 'src/index.ts'), 'export const value = 1;\n');
    // Deny only imports originating inside tsdown, without moving shared node_modules.
    // The SDK config still resolves its own explicitly imported validators.
    const hook = join(fixture, 'deny-tsdown-validators.mjs');
    writeFileSync(
      hook,
      `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/node_modules/tsdown/') &&
        ['publint', 'publint/utils', '@arethetypeswrong/core'].includes(specifier)) {
      throw new Error('ENG768: validator unavailable from tsdown: ' + specifier);
    }
    return nextResolve(specifier, context);
  }
});\n`,
    );
    const configUrl = new URL(
      '../packages/sdk/tsdown.config.ts',
      import.meta.url,
    );
    for (const fallback of [null, 'publint', 'attw']) {
      const config = join(fixture, 'tsdown.config.mjs');
      writeFileSync(
        config,
        `import base from ${JSON.stringify(configUrl.href)};
const config = { ...base, cwd: ${JSON.stringify(fixture)} };
${fallback ? `config.${fallback} = { ...config.${fallback}, module: undefined };` : ''}
export default config;\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          hook,
          fileURLToPath(import.meta.resolve('tsdown/run')),
          '--config',
          config,
        ],
        {
          cwd: fixture,
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...process.env,
            NO_COLOR: '1',
            npm_config_cache: join(fixture, 'npm-cache'),
            NPM_CONFIG_CACHE: join(fixture, 'npm-cache'),
          },
        },
      );
      assert.equal(result.error, undefined);
      const output = result.stdout + result.stderr;
      if (fallback) {
        assert.notEqual(result.status, 0, output);
        assert.match(output, /Failed to import module/, output);
      } else {
        assert.equal(result.status, 0, output);
        assert.match(output, /\[publint\] No issues found/);
        assert.match(output, /\[attw\] No problems found/);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
