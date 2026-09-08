import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
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

const root = fileURLToPath(new URL('../', import.meta.url));
const prWorkflow = parse(
  readFileSync(join(root, '.github/workflows/e2e-pr.yml'), 'utf8'),
);
const gate = prWorkflow.jobs['e2e-gate'];
const gateStep = gate.steps.find((step) => step.env?.ACCEPTANCE);

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
