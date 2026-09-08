import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  checkWorkflows,
  inspectWorkflow,
  repoRoot,
} from './check-workflows.mjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const digest = '0123456789abcdef'.repeat(4);
const pinnedAction = `owner/action@${commit}`;

function workflow(steps) {
  return `name: Fixture\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
}

function inspect(steps) {
  return inspectWorkflow(workflow(steps), 'fixture.yml');
}

for (const reference of [
  'owner/action@main',
  'owner/action@v7',
  'owner/action@v7.0.1',
  'owner/action',
  'owner/action@0123456',
  `owner/action@${commit.slice(1)}`,
  `owner/action@${commit}0`,
  `owner/action@${'z'.repeat(40)}`,
  `owner/action@\${{ github.sha }}`,
  'docker://alpine:3.21',
  'docker://alpine:latest',
  'docker://alpine@sha256:1234',
]) {
  test(`sabotage: rejects mutable or malformed reference ${reference}`, () => {
    const failures = inspect(`      - uses: ${reference} # v7.0.1`);
    assert(failures.some((failure) => failure.includes('pin to a full')));
    assert(failures.every((failure) => failure.includes('fixture.yml:')));
  });
}

for (const value of ['null', 'false', '123', '[owner/action@v1]']) {
  test(`sabotage: rejects non-string uses: ${value}`, () => {
    assert.match(
      inspect(`      - uses: ${value} # v1.0.0`).join('\n'),
      /expected a string action reference/,
    );
  });
}

for (const step of [
  `      - uses: ${pinnedAction} # v1.2.3`,
  `      - uses: '${pinnedAction}' # v1.2.3`,
  `      - "uses": "${pinnedAction}" # v1.2.3`,
  `      - { uses: '${pinnedAction}' # v1.2.3\n        }`,
  `      - uses: >- # v1.2.3\n          ${pinnedAction}`,
  `      - uses: |- # v1.2.3\n          ${pinnedAction}`,
  `      - uses: owner/action/subpath@${commit} # v1.2.3`,
  `      - uses: docker://alpine@sha256:${digest} # 3.21.0`,
  '      - uses: ./local/action',
  '      - run: echo OK',
]) {
  test(`accepts immutable or local action syntax: ${step.trim()}`, () => {
    assert.deepEqual(inspect(step), []);
  });
}

test('sabotage: flow-style and multiline mutable references are rejected', () => {
  for (const step of [
    '      - { "uses": "owner/action@main" }',
    '      - uses: >-\n          owner/action@main',
    '      - uses: |-\n          owner/action@v1',
  ]) {
    assert.match(inspect(step).join('\n'), /pin to a full/);
  }
});

test('sabotage: missing or uninformative version comments are rejected', () => {
  for (const comment of ['', ' # pinned', ' # audited']) {
    assert.match(
      inspect(`      - uses: ${pinnedAction}${comment}`).join('\n'),
      /add a release-version comment/,
    );
  }
});

test('ignores commented uses, shell text, and action inputs named uses', () => {
  assert.deepEqual(
    inspect(`      # - uses: owner/action@main
      - run: |
          uses: owner/action@main
      - uses: ${pinnedAction} # v1.2.3
        with:
          uses: owner/action@main`),
    [],
  );
});

test('sabotage: reusable workflow jobs must also be immutable', () => {
  const reusable = (reference) =>
    `on: push\njobs:\n  reuse:\n    uses: ${reference} # v1.2.3\n`;
  assert.match(
    inspectWorkflow(
      reusable('owner/repo/.github/workflows/build.yml@main'),
    ).join('\n'),
    /jobs.reuse.uses: pin to a full/,
  );
  assert.deepEqual(
    inspectWorkflow(
      reusable(`owner/repo/.github/workflows/build.yml@${commit}`),
    ),
    [],
  );
  assert.deepEqual(
    inspectWorkflow(reusable('./.github/workflows/build.yml')),
    [],
  );
});

test('resolves YAML aliases for action references, steps, and jobs', () => {
  const source = `on: push
jobs:
  original: &job
    runs-on: ubuntu-latest
    steps: &steps
      - &step
        uses: &action ${pinnedAction} # v1.2.3
      - uses: *action
      - *step
  duplicate: *job
  repeated:
    runs-on: ubuntu-latest
    steps: *steps
`;
  assert.deepEqual(inspectWorkflow(source), []);
  const failures = inspectWorkflow(
    source.replace(pinnedAction, 'owner/action@main'),
  );
  for (const job of ['original', 'duplicate', 'repeated']) {
    assert(
      failures.some((failure) =>
        failure.includes(`jobs.${job}.steps[1].uses: pin to a full`),
      ),
    );
  }
});

test('sabotage: merge keys fail without relying on another workflow defect', () => {
  for (const source of [
    workflow(`      - <<:
          uses: owner/action@main # v1.2.3`),
    `on: push
x-step: &step
  uses: owner/action@main # v1.2.3
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - <<: *step
`,
  ]) {
    assert.deepEqual(inspectWorkflow(source, 'merge.yml'), [
      'merge.yml: YAML merge keys are not supported',
    ]);
  }
});

for (const source of [
  'jobs: [',
  'jobs: {}\njobs: {}',
  'jobs: {}\n---\njobs: {}',
  'jobs: *missing',
  'jobs: !unknown {}',
  '',
  'jobs: {}',
  'jobs: []',
  'jobs: { test: null }',
  'jobs: { test: { steps: [] } }',
  'jobs: { test: { steps: [null] } }',
]) {
  test(`sabotage: fails closed for invalid or vacuous workflows: ${source}`, () => {
    assert(inspectWorkflow(source).length > 0);
  });
}

test('CLI discovers .yml and .yaml files and fails for new mutable references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-policy-'));
  try {
    const run = () => {
      const result = spawnSync(
        process.execPath,
        [resolve(repoRoot, 'scripts/check-workflows.mjs'), directory],
        {
          cwd: tmpdir(),
          encoding: 'utf8',
        },
      );
      assert.ifError(result.error);
      return result;
    };
    assert.equal(run().status, 1);
    writeFileSync(
      join(directory, 'valid.yml'),
      workflow(`      - uses: ${pinnedAction} # v1.2.3`),
    );
    assert.equal(run().status, 0);
    writeFileSync(
      join(directory, 'new.yaml'),
      workflow('      - uses: owner/action@main # v1.2.3'),
    );
    const result = run();
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /new.yaml: jobs.test.steps\[0\].uses: pin to a full/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readWorkflow(
  filename,
  directory = resolve(repoRoot, '.github/workflows'),
) {
  return parse(readFileSync(resolve(directory, filename), 'utf8'));
}

test('wiring: all repository workflow references satisfy the policy', () => {
  assert.deepEqual(checkWorkflows(), []);
});

test('wiring: CI and release validation run the guard before building', () => {
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['check:workflows'],
    'node --test scripts/check-workflows.test.mjs && node scripts/check-workflows.mjs',
  );
  const biome = JSON.parse(
    readFileSync(resolve(repoRoot, 'biome.json'), 'utf8'),
  );
  for (const path of [
    'scripts/check-workflows.mjs',
    'scripts/check-workflows.test.mjs',
  ]) {
    assert(biome.files.includes.includes(path));
  }
  for (const [filename, job] of [
    ['ci.yml', 'test'],
    ['release.yml', 'validate'],
  ]) {
    const steps = readWorkflow(filename).jobs[job].steps;
    const guard = steps.findIndex(
      (step) => step.run === 'npm run check:workflows',
    );
    assert(guard > steps.findIndex((step) => step.run === 'npm ci'));
    assert(guard < steps.findIndex((step) => step.run === 'npm run build'));
    assert.equal(steps[guard].if, undefined);
    assert.equal(steps[guard]['continue-on-error'], undefined);
  }
});

function assertWorkflowPermissions(
  directory = resolve(repoRoot, '.github/workflows'),
) {
  const filenames = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.match(/\.ya?ml$/))
    .map((entry) => entry.name)
    .sort();
  assert(filenames.length > 0, 'no workflow YAML files found');
  for (const filename of filenames) {
    const workflow = readWorkflow(filename, directory);
    assert.deepEqual(
      workflow.permissions,
      { contents: 'read' },
      `${filename}: workflow permissions must be contents: read`,
    );
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const permissions = job.permissions ?? workflow.permissions;
      if (filename === 'release.yml' && name === 'release') {
        assert.deepEqual(permissions, {
          contents: 'read',
          'id-token': 'write',
        });
      } else if (filename === 'release.yml' && name === 'github-release') {
        assert.deepEqual(permissions, { contents: 'write' });
      } else {
        assert(
          Object.keys(permissions).every(
            (scope) => scope === 'contents' && permissions[scope] === 'read',
          ),
          `${filename}: jobs.${name}: permissions must be read-only`,
        );
      }
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/checkout@')) {
          assert.equal(
            step.with?.['persist-credentials'],
            false,
            `${filename}: jobs.${name}: checkout must set persist-credentials: false`,
          );
        }
      }
    }
  }
}

for (const extension of ['yml', 'yaml']) {
  test(`sabotage: permissions cover newly added .${extension} workflows`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'workflow-permissions-'));
    try {
      cpSync(resolve(repoRoot, '.github/workflows'), directory, {
        recursive: true,
      });
      assertWorkflowPermissions(directory);
      const filename = join(directory, `future-workflow.${extension}`);
      const source = `name: Future workflow
on: pull_request_target
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${commit} # v7.0.1
        with:
          persist-credentials: false
      - run: echo fixture
`;
      writeFileSync(filename, source);
      assert.deepEqual(checkWorkflows(directory), []);
      assertWorkflowPermissions(directory);

      for (const [mutation, message] of [
        [
          source.replace(
            'permissions:\n  contents: read',
            'permissions: write-all',
          ),
          /future-workflow\.ya?ml: workflow permissions/,
        ],
        [
          source.replace(
            '    runs-on:',
            '    permissions:\n      contents: write\n    runs-on:',
          ),
          /future-workflow\.ya?ml: jobs.test: permissions/,
        ],
        [
          source.replace(
            'persist-credentials: false',
            'persist-credentials: true',
          ),
          /future-workflow\.ya?ml: jobs.test: checkout must set persist-credentials: false/,
        ],
        [
          source.replace(
            '        with:\n          persist-credentials: false\n',
            '',
          ),
          /future-workflow\.ya?ml: jobs.test: checkout must set persist-credentials: false/,
        ],
      ]) {
        writeFileSync(filename, mutation);
        assert.deepEqual(checkWorkflows(directory), []);
        assert.throws(() => assertWorkflowPermissions(directory), message);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('wiring: permissions stay read-only except for isolated release jobs', () => {
  assertWorkflowPermissions();
  const { jobs } = readWorkflow('release.yml');
  assert.equal(jobs.release.needs, 'validate');
  assert.equal(jobs['github-release'].needs, 'release');
  assert.equal(jobs['github-release'].steps.length, 1);
  assert.equal(jobs['github-release'].steps[0].uses, undefined);
  assert.equal(
    jobs['github-release'].steps[0].env.GH_REPO,
    `\${{ github.repository }}`,
  );
  assert.equal(
    jobs.validate.steps.some((step) => step.run?.includes('npm publish')),
    false,
  );
});

test('wiring: Dependabot continues proposing weekly GitHub Actions PRs', () => {
  const dependabot = parse(
    readFileSync(resolve(repoRoot, '.github/dependabot.yml'), 'utf8'),
  );
  const actions = dependabot.updates.find(
    (entry) => entry['package-ecosystem'] === 'github-actions',
  );
  assert(actions);
  assert.equal(actions.directory, '/');
  assert.equal(actions.schedule.interval, 'weekly');
  assert.notEqual(actions['open-pull-requests-limit'], 0);
});
