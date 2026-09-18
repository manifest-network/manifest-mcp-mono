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

const root = new URL('../', import.meta.url);
const authorityMembers = [
  'data/callbacks.db',
  'data/releases.db',
  'data/retention.db',
  'data/callbacks.db.storage-identity-anchor.json',
  'volumes/.fred-backend-storage-identity.json',
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fred-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'data'));
  mkdirSync(join(directory, 'volumes'));
  const binary = join(directory, 'fred-command');
  const log = join(directory, 'calls.jsonl');
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FRED_TEST_LOG, JSON.stringify(args) + '\\n');
if (args.includes(process.env.FRED_TEST_FAIL_MODE)) process.exit(17);
if (args.includes('--print-fresh-confirmation')) console.log('exact target confirmation\\nprovider and roster');
`,
    { mode: 0o700 },
  );
  return {
    directory,
    run(script, extra = {}) {
      return spawnSync(
        '/bin/sh',
        [fileURLToPath(new URL(`e2e/scripts/${script}`, root))],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            FRED_BACKEND_BIN: binary,
            FRED_BACKEND_CONFIG: '/shared/docker-backend.yaml',
            FRED_BACKEND_DATA_DIR: join(directory, 'data'),
            FRED_VOLUME_DATA_PATH: join(directory, 'volumes'),
            FRED_PREFLIGHT_BIN: binary,
            FRED_PROVIDER_CONFIG: '/shared/providerd.yaml',
            FRED_PLACEMENT_DB: join(directory, 'data/placements.db'),
            FRED_TEST_LOG: log,
            ...extra,
          },
        },
      );
    },
    calls() {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

test('fresh backend invokes the upstream empty-storage proof exactly once', (t) => {
  const f = fixture(t);
  const result = f.run('init_backend.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    [
      '--config',
      '/shared/docker-backend.yaml',
      '--initialize-storage-identity',
      'new',
    ],
  ]);
});

test('backend initialization propagates refusal without fallback or retry', (t) => {
  const f = fixture(t);
  assert.equal(
    f.run('init_backend.sh', {
      FRED_TEST_FAIL_MODE: '--initialize-storage-identity',
    }).status,
    17,
  );
  assert.equal(f.calls().length, 1);
});

test('complete existing backend authority is left for runtime verification', (t) => {
  const f = fixture(t);
  // Deliberately invalid bytes: the shell must never try to repair/reseal them.
  for (const path of authorityMembers)
    writeFileSync(join(f.directory, path), 'unverified');
  const result = f.run('init_backend.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /normal startup will verify/);
  assert.deepEqual(f.calls(), []);
});

for (const missing of authorityMembers) {
  test(`partial backend authority refuses initialization when ${missing} is missing`, (t) => {
    const f = fixture(t);
    for (const path of authorityMembers) {
      if (path !== missing) writeFileSync(join(f.directory, path), 'preserve');
    }
    const result = f.run('init_backend.sh');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /incomplete backend authority/);
    assert.deepEqual(f.calls(), []);
  });
}

test('a dangling backend authority symlink is not mistaken for fresh storage', (t) => {
  const f = fixture(t);
  symlinkSync('missing', join(f.directory, authorityMembers[0]));
  assert.equal(f.run('init_backend.sh').status, 1);
  assert.deepEqual(f.calls(), []);
});

test('fresh placement forwards the exact confirmation and local-chain acknowledgment', (t) => {
  const f = fixture(t);
  const result = f.run('init_placement.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    [
      '--config',
      '/shared/providerd.yaml',
      '--print-fresh-confirmation',
      '--expected-backends',
      '["docker-1"]',
    ],
    [
      '--config',
      '/shared/providerd.yaml',
      '--initialize-fresh',
      '--expected-backends',
      '["docker-1"]',
      '--confirm-insecure-chain',
      'I ACCEPT UNAUTHENTICATED CHAIN EVIDENCE FOR LOCAL DEVELOPMENT',
      '--confirm-quiesced',
      'exact target confirmation\nprovider and roster',
    ],
  ]);
});

for (const failure of ['--print-fresh-confirmation', '--initialize-fresh']) {
  test(`placement propagates ${failure} refusal`, (t) => {
    const f = fixture(t);
    assert.equal(
      f.run('init_placement.sh', { FRED_TEST_FAIL_MODE: failure }).status,
      17,
    );
    assert.equal(
      f.calls().length,
      failure === '--print-fresh-confirmation' ? 1 : 2,
    );
  });
}

for (const kind of ['empty', 'corrupt', 'dangling symlink']) {
  test(`existing ${kind} placement authority is never reinitialized`, (t) => {
    const f = fixture(t);
    const path = join(f.directory, 'data/placements.db');
    if (kind === 'dangling symlink') symlinkSync('missing', path);
    else writeFileSync(path, kind === 'empty' ? '' : 'corrupt');
    const result = f.run('init_placement.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /providerd will verify/);
    assert.deepEqual(f.calls(), []);
  });
}

test('Compose gates provider ingress on initialization and shares durable authority', () => {
  const { services } = parse(
    readFileSync(new URL('e2e/docker-compose.yml', root), 'utf8'),
  );
  assert.deepEqual(services['backend-init'].depends_on, {
    init: { condition: 'service_completed_successfully' },
  });
  assert.deepEqual(services['docker-backend'].depends_on, {
    'backend-init': { condition: 'service_completed_successfully' },
  });
  assert.deepEqual(services['placement-init'].depends_on, {
    'docker-backend': { condition: 'service_healthy' },
  });
  assert.deepEqual(services.providerd.depends_on, {
    'placement-init': { condition: 'service_completed_successfully' },
  });
  for (const name of ['backend-init', 'docker-backend']) {
    assert.ok(services[name].volumes.includes('docker-backend-data:/data'));
    assert.ok(services[name].volumes.includes('/mnt/fred-xfs:/mnt/fred-xfs'));
    assert.ok(
      services[name].volumes.includes(
        '/var/run/docker.sock:/var/run/docker.sock',
      ),
    );
  }
  for (const name of ['placement-init', 'providerd']) {
    assert.ok(services[name].volumes.includes('providerd-data:/data'));
    assert.ok(services[name].volumes.includes('shared-data:/shared:ro'));
  }
  assert.match(
    services['docker-backend'].healthcheck.test,
    /--cacert .* https:\/\/localhost:9001\/health/,
  );
});

function generatedFredConfig() {
  const script = readFileSync(
    new URL('e2e/scripts/init_billing.sh', root),
    'utf8',
  );
  const config = (name) => {
    const start = script.indexOf(`cat > /shared/${name}.yaml << YAML\n`);
    assert.notEqual(start, -1);
    const bodyStart = script.indexOf('\n', start) + 1;
    return parse(script.slice(bodyStart, script.indexOf('\nYAML', bodyStart)));
  };
  return {
    script,
    provider: config('providerd'),
    backend: config('docker-backend'),
  };
}

test('generated Fred configuration supplies verified backend TLS and exact persistent paths', () => {
  const { script, provider, backend } = generatedFredConfig();
  assert.equal(provider.backends[0].url, 'https://docker-backend:9001');
  assert.equal(provider.backends[0].tls_ca_file, '/shared/tls/cert.pem');
  assert.equal(provider.backends[0].tls_skip_verify, undefined);
  assert.equal(provider.placement_store_db_path, '/data/placements.db');
  assert.equal(backend.tls_cert_file, '/shared/tls/cert.pem');
  assert.equal(backend.tls_key_file, '/shared/tls/key.pem');
  assert.equal(backend.volume_mount_path, '/mnt/fred-xfs');
  assert.equal(backend.volume_data_path, '/mnt/fred-xfs');
  for (const [key, filename] of [
    ['callback_db_path', 'callbacks.db'],
    ['releases_db_path', 'releases.db'],
    ['retention_db_path', 'retention.db'],
  ]) {
    assert.equal(backend[key], `/data/${filename}`);
  }
  assert.match(script, /subjectAltName=[^\n"]*DNS:docker-backend/);
});

function assertInitializerDefaultsMatchConfig(
  provider,
  backend,
  backendScript,
  placementScript,
) {
  const shellDefault = (script, variable) => {
    const match = script.match(
      new RegExp(`^${variable}=\\$\\{[^}]+:-([^}]+)\\}$`, 'm'),
    );
    assert(match, `missing shell default for ${variable}`);
    return match[1];
  };
  assert.equal(
    shellDefault(backendScript, 'backend_config'),
    '/shared/docker-backend.yaml',
  );
  assert.equal(
    shellDefault(placementScript, 'provider_config'),
    '/shared/providerd.yaml',
  );
  assert.equal(
    shellDefault(placementScript, 'placement_db'),
    provider.placement_store_db_path,
  );
  const directories = {
    backend_data: shellDefault(backendScript, 'backend_data'),
    volume_data: shellDefault(backendScript, 'volume_data'),
  };
  const checkedPaths = [
    ...backendScript.matchAll(/"\$(backend_data|volume_data)\/([^"\n]+)"/g),
  ].map(([, directory, filename]) => `${directories[directory]}/${filename}`);
  // Compare what the fresh/restart guard actually probes (without the fixture's
  // environment overrides) with the paths that Fred will open from its config.
  assert.deepEqual(
    checkedPaths.sort(),
    [
      backend.callback_db_path,
      backend.releases_db_path,
      backend.retention_db_path,
      `${backend.callback_db_path}.storage-identity-anchor.json`,
      `${backend.volume_data_path}/.fred-backend-storage-identity.json`,
    ].sort(),
  );
  const roster = placementScript.match(/^expected_backends='([^']+)'$/m);
  assert(roster);
  assert.deepEqual(
    JSON.parse(roster[1]),
    provider.backends.map(({ name }) => name),
  );
}

test('initializer defaults and probed authority members match generated Fred config', () => {
  const { provider, backend } = generatedFredConfig();
  const backendScript = readFileSync(
    new URL('e2e/scripts/init_backend.sh', root),
    'utf8',
  );
  const placementScript = readFileSync(
    new URL('e2e/scripts/init_placement.sh', root),
    'utf8',
  );
  assertInitializerDefaultsMatchConfig(
    provider,
    backend,
    backendScript,
    placementScript,
  );
  for (const [changedBackend, changedPlacement] of [
    [
      backendScript.replace(
        'FRED_BACKEND_DATA_DIR:-/data',
        'FRED_BACKEND_DATA_DIR:-/other',
      ),
      placementScript,
    ],
    [
      backendScript.replace('callbacks.db"', 'other-callbacks.db"'),
      placementScript,
    ],
    [
      backendScript.replace(
        'FRED_VOLUME_DATA_PATH:-/mnt/fred-xfs',
        'FRED_VOLUME_DATA_PATH:-/other',
      ),
      placementScript,
    ],
    [
      backendScript,
      placementScript.replace(
        'FRED_PLACEMENT_DB:-/data/placements.db',
        'FRED_PLACEMENT_DB:-/other/placements.db',
      ),
    ],
    [backendScript, placementScript.replace('docker-1', 'docker-2')],
  ]) {
    assert.throws(() =>
      assertInitializerDefaultsMatchConfig(
        provider,
        backend,
        changedBackend,
        changedPlacement,
      ),
    );
  }
});
