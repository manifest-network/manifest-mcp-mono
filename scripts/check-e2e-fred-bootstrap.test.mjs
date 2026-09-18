import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { nativeBackendConfig } from '../e2e/scripts/native-backend-config.mjs';

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

test('Compose preserves provider authority without admitting a container writer on the XFS root', () => {
  const { services } = parse(
    readFileSync(new URL('e2e/docker-compose.yml', root), 'utf8'),
  );
  assert.deepEqual(services.providerd.depends_on, {
    'placement-init': { condition: 'service_completed_successfully' },
  });
  for (const [name, service] of Object.entries(services)) {
    for (const volume of service.volumes ?? []) {
      const source =
        typeof volume === 'string' ? volume.split(':')[0] : volume.source;
      assert.notEqual(
        source,
        '/mnt/fred-xfs',
        `${name} must not own a container mount of the stateful root`,
      );
    }
  }
  for (const name of ['placement-init', 'providerd']) {
    assert.ok(services[name].volumes.includes('providerd-data:/data'));
    assert.ok(services[name].volumes.includes('shared-data:/shared:ro'));
    assert.ok(
      services[name].extra_hosts.includes('docker-backend:host-gateway'),
    );
  }
});

function generatedFredConfig(compatibility = 'pr240') {
  const script = readFileSync(
    new URL('e2e/scripts/init_billing.sh', root),
    'utf8',
  );
  const config = (name) => {
    const start = script.indexOf(`cat > /shared/${name}.yaml << YAML\n`);
    assert.notEqual(start, -1);
    const bodyStart = script.indexOf('\n', start) + 1;
    const body = script.slice(bodyStart, script.indexOf('\nYAML', bodyStart));
    const mode = script.slice(
      script.indexOf('case "${FRED_COMPATIBILITY'),
      script.indexOf('\nesac') + 6,
    );
    const env = Object.fromEntries(
      [...body.matchAll(/\$\{([A-Z_]+)\}/g)].map(([, name]) => [name, name]),
    );
    const result = spawnSync(
      'bash',
      ['-c', `${mode}\ncat << YAML\n${body}\nYAML\n`],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env, FRED_COMPATIBILITY: compatibility },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return parse(result.stdout);
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
  assert.equal(provider.callback_base_url, 'https://127.0.0.1:8080');
});

test('legacy configuration keeps its supported HTTP backend and container callback topology', () => {
  const { provider, backend } = generatedFredConfig('v0.13');
  assert.equal(provider.backends[0].url, 'http://docker-backend:9001');
  assert.equal(provider.backends[0].tls_ca_file, undefined);
  assert.equal(provider.callback_base_url, 'https://providerd:8080');
  assert.equal(provider.placement_store_db_path, '/data/placements.db');
  assert.equal(backend.tls_cert_file, undefined);
  assert.equal(backend.volume_mount_path, undefined);
  assert.equal(backend.volume_data_path, '/mnt/fred-xfs');
  const modern = parse(
    readFileSync(new URL('e2e/docker-compose.yml', root), 'utf8'),
  );
  const legacy = parse(
    readFileSync(new URL('e2e/docker-compose.v013.yml', root), 'utf8'),
  );
  assert.equal(legacy.services.providerd.build.context, './.fred-v013');
  assert(
    legacy.services['docker-backend'].volumes.includes(
      'docker-backend-data:/data',
    ),
  );
  assert.equal(legacy.services.init.environment.FRED_COMPATIBILITY, 'v0.13');
  const modernNames = new Set(
    Object.values(modern.volumes).map((volume) => volume.name),
  );
  for (const volume of Object.values(legacy.volumes))
    assert(!modernNames.has(volume.name));
  assert.equal(legacy.services['placement-init'], undefined);
});

test('native configuration uses the exact persistent host paths without rewriting unrelated values', () => {
  const { backend } = generatedFredConfig();
  const source = {
    ...backend,
    callback_secret: 'literal /data/ and /shared/ text',
  };
  const actual = parse(
    nativeBackendConfig(stringify(source), {
      backendData: '/host/backend authority',
      sharedData: '/host/shared authority',
    }),
  );
  assert.deepEqual(actual, {
    ...source,
    tls_cert_file: '/host/shared authority/tls/cert.pem',
    tls_key_file: '/host/shared authority/tls/key.pem',
    callback_db_path: '/host/backend authority/callbacks.db',
    diagnostics_db_path: '/host/backend authority/diagnostics.db',
    releases_db_path: '/host/backend authority/releases.db',
    retention_db_path: '/host/backend authority/retention.db',
  });
});

test('native configuration CLI keeps generated credentials private', (t) => {
  const f = fixture(t);
  const source = join(f.directory, 'source.yaml');
  const destination = join(f.directory, 'native.yaml');
  writeFileSync(source, stringify(generatedFredConfig().backend));
  writeFileSync(destination, 'previous configuration', { mode: 0o644 });
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('e2e/scripts/native-backend-config.mjs', root)),
      source,
      destination,
      join(f.directory, 'data'),
      join(f.directory, 'shared'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.equal(
    parse(readFileSync(destination, 'utf8')).callback_db_path,
    join(f.directory, 'data/callbacks.db'),
  );
});

test('native configuration rejects authority paths outside the expected roots', () => {
  const { backend } = generatedFredConfig();
  for (const callback_db_path of [
    '/other/callbacks.db',
    '/data/../callbacks.db',
  ]) {
    assert.throws(() =>
      nativeBackendConfig(stringify({ ...backend, callback_db_path }), {
        backendData: '/host/backend',
        sharedData: '/host/shared',
      }),
    );
  }
  assert.throws(() =>
    nativeBackendConfig(stringify(backend), {
      backendData: 'relative/backend',
      sharedData: '/host/shared',
    }),
  );
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

function nativeLauncherFixture(t) {
  const f = fixture(t);
  const commands = join(f.directory, 'bin');
  const shared = join(f.directory, 'shared');
  mkdirSync(commands);
  mkdirSync(shared);
  writeFileSync(
    join(shared, 'docker-backend.yaml'),
    stringify(generatedFredConfig().backend),
  );
  const shim = join(commands, 'command-probe');
  // Storage initialization is exercised directly above. Stub that boundary here,
  // together with every daemon command, so orchestration never inspects host XFS.
  writeFileSync(
    shim,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.FRED_TEST_LOG, JSON.stringify({ command, args,
  backendData: env.FRED_BACKEND_DATA_DIR, volumeData: env.FRED_VOLUME_DATA_PATH,
  backendConfig: env.FRED_BACKEND_CONFIG }) + '\\n');
if (command === 'id') { console.log('0'); process.exit(0); }
if (command === 'systemctl' && args.includes('is-active')) process.exit(3);
if (command === 'systemctl' && args[0] === 'show' && env.FRED_TEST_UNIT_MISSING) {
  console.log('not-found'); process.exit(1);
}
if (command === 'docker') {
  if (args.includes('ps') && env.FRED_TEST_RUNNING_PROVIDER) console.log('providerd');
  if (args[0] === 'create') console.log('backend-image-export');
  if (args[0] === 'cp') fs.copyFileSync(__filename, args.at(-1));
  if (args[0] === 'volume' && args[1] === 'inspect') {
    if (!args.includes('--format')) process.exit(args[2] === env.FRED_TEST_EXISTING_VOLUME ? 0 : 1);
    console.log(args.includes('mcp-e2e-shared-data') ? env.FRED_TEST_SHARED : env.FRED_TEST_DATA);
  }
  if (args[0] === 'volume' && args[1] === 'create') console.log(args.at(-1));
}
if (command === 'sh' && args.at(-1).endsWith('/init_backend.sh')) {
  if (env.FRED_TEST_FAIL_STEP === 'backend-init') process.exit(17);
}
if (command === 'curl' && env.FRED_TEST_FAIL_STEP === 'health') process.exit(22);
`,
    { mode: 0o700 },
  );
  for (const command of [
    'docker',
    'systemctl',
    'systemd-run',
    'journalctl',
    'curl',
    'id',
    'sleep',
    'sh',
    'xfs_quota',
  ]) {
    symlinkSync(shim, join(commands, command));
  }
  return {
    ...f,
    shared,
    run(command, extra = {}) {
      return spawnSync(
        '/bin/bash',
        [fileURLToPath(new URL('e2e/scripts/devnet.sh', root)), command],
        {
          encoding: 'utf8',
          timeout: 15_000,
          env: {
            ...process.env,
            PATH: `${commands}:${process.env.PATH}`,
            FRED_NATIVE_BACKEND_DIR: join(f.directory, 'native'),
            FRED_DEVNET_WAIT_TIMEOUT: '1',
            FRED_BACKEND_UNIT: 'fred-bootstrap-test',
            FRED_COMPATIBILITY: 'pr240',
            FRED_TEST_SHARED: shared,
            FRED_TEST_DATA: join(f.directory, 'data'),
            FRED_TEST_LOG: join(f.directory, 'calls.jsonl'),
            ...extra,
          },
        },
      );
    },
  };
}

test('native launcher admits storage and verifies health before exposing provider ingress', (t) => {
  const f = nativeLauncherFixture(t);
  const result = f.run('up');
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const at = (predicate) => {
    const index = calls.findIndex(predicate);
    assert.notEqual(index, -1, JSON.stringify(calls));
    return index;
  };
  const initialization = at(
    ({ command, args }) =>
      command === 'sh' && args.at(-1).endsWith('/init_backend.sh'),
  );
  const launch = at(({ command }) => command === 'systemd-run');
  const healthy = at(({ command }) => command === 'curl');
  const placement = at(
    ({ command, args }) =>
      command === 'docker' && args.includes('placement-init'),
  );
  const ingress = at(
    ({ command, args }) => command === 'docker' && args.includes('providerd'),
  );
  assert.ok(
    initialization < launch &&
      launch < healthy &&
      healthy < placement &&
      placement < ingress,
  );
  const config = parse(
    readFileSync(calls[initialization].backendConfig, 'utf8'),
  );
  assert.equal(calls[initialization].backendData, join(f.directory, 'data'));
  assert.equal(calls[initialization].volumeData, config.volume_data_path);
  assert.equal(
    config.callback_db_path,
    join(calls[initialization].backendData, 'callbacks.db'),
  );
  assert.ok(calls[healthy].args.includes('--cacert'));
  assert.ok(calls[healthy].args.includes(join(f.shared, 'tls/cert.pem')));
  assert.ok(calls[healthy].args.includes('https://127.0.0.1:9001/health'));
});

for (const step of ['backend-init', 'health']) {
  test(`native launcher does not admit placement or ingress after ${step} refusal`, (t) => {
    const f = nativeLauncherFixture(t);
    const result = f.run('up', { FRED_TEST_FAIL_STEP: step });
    assert.equal(
      result.status,
      step === 'backend-init' ? 17 : 1,
      result.stderr,
    );
    assert.ok(
      !f
        .calls()
        .some(
          ({ args }) =>
            args.includes('placement-init') || args.includes('providerd'),
        ),
    );
  });
}

test('normal native shutdown stops the host service and preserves storage authority', (t) => {
  const f = nativeLauncherFixture(t);
  const result = f.run('down');
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const stop = calls.findIndex(
    ({ command, args }) => command === 'systemctl' && args.includes('stop'),
  );
  const down = calls.findIndex(
    ({ command, args }) => command === 'docker' && args.includes('down'),
  );
  assert.ok(stop >= 0 && down > stop);
  assert.ok(
    !calls.some(
      ({ args }) =>
        args.includes('--volumes') ||
        args.includes('-v') ||
        (args[0] === 'volume' && args[1] === 'rm'),
    ),
  );
});

test('native shutdown still tears down Compose when the transient unit no longer exists', (t) => {
  const f = nativeLauncherFixture(t);
  const result = f.run('down', { FRED_TEST_UNIT_MISSING: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    f
      .calls()
      .some(
        ({ command, args }) => command === 'docker' && args.includes('down'),
      ),
  );
  assert.ok(
    !f
      .calls()
      .some(
        ({ command, args }) => command === 'systemctl' && args.includes('stop'),
      ),
  );
});

test('native startup refuses existing provider ingress before initializing authority', (t) => {
  const f = nativeLauncherFixture(t);
  const result = f.run('up', { FRED_TEST_RUNNING_PROVIDER: '1' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Provider ingress is already running/);
  assert.ok(
    !f
      .calls()
      .some(({ command }) => command === 'systemd-run' || command === 'sh'),
  );
});

test('native devnet logs include the host backend journal', (t) => {
  const f = nativeLauncherFixture(t);
  const result = f.run('logs');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    f
      .calls()
      .some(
        ({ command, args }) => command === 'docker' && args.includes('logs'),
      ),
  );
  assert.ok(
    f
      .calls()
      .some(
        ({ command, args }) =>
          command === 'journalctl' &&
          args.some((arg) => arg.includes('fred-bootstrap-test')),
      ),
  );
});

for (const [compatibility, volume] of [
  ['v0.13', 'mcp-e2e'],
  ['pr240', 'mcp-e2e-v013'],
].flatMap(([mode, prefix]) =>
  ['shared-data', 'docker-backend-data', 'providerd-data', 'chain-data'].map(
    (suffix) => [mode, `${prefix}-${suffix}`],
  ),
)) {
  test(`${compatibility} refuses leftover ${volume} without the other volumes`, (t) => {
    const f = nativeLauncherFixture(t);
    const result = f.run('up', {
      FRED_COMPATIBILITY: compatibility,
      FRED_TEST_EXISTING_VOLUME: volume,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /storage exists/);
    assert(
      !f
        .calls()
        .some(
          ({ command, args }) =>
            command === 'systemd-run' || args.includes('up'),
        ),
    );
  });
}

test('legacy startup and shutdown use isolated Compose without native authority initialization', (t) => {
  const f = nativeLauncherFixture(t);
  for (const command of ['up', 'down']) {
    const result = f.run(command, { FRED_COMPATIBILITY: 'v0.13' });
    assert.equal(result.status, 0, result.stderr);
  }
  const commands = f.calls();
  assert(
    !commands.some(
      ({ command }) => command === 'systemd-run' || command === 'sh',
    ),
  );
  for (const { args } of commands.filter(({ args }) =>
    args.includes('compose'),
  )) {
    assert(args.includes('mcp-e2e-v013'));
    assert(args.some((arg) => arg.endsWith('/e2e/docker-compose.v013.yml')));
    assert(!args.includes('--volumes'));
  }
});
