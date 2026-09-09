import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDockerHost, validateE2EEnvironment } from './check-e2e-env.mjs';

const ready = {
  platform: 'linux',
  mount: {
    target: '/mnt/fred-xfs',
    fstype: 'xfs',
    options: 'rw,relatime,prjquota',
  },
  quotaState: 'Project quota state\n  Accounting: ON\n  Enforcement: ON\n',
  dockerHost: 'unix:///var/run/docker.sock',
};

test('accepts the documented Linux XFS setup and quota option alias', () => {
  assert.deepEqual(validateE2EEnvironment(ready), []);
  assert.deepEqual(
    validateE2EEnvironment({
      ...ready,
      mount: { ...ready.mount, options: 'rw,pquota' },
    }),
    [],
  );
});

test('rejects directory/parent mount, wrong filesystem, inactive quotas and remote Docker', () => {
  for (const patch of [
    { platform: 'darwin' },
    { mount: undefined },
    { mount: { ...ready.mount, target: '/' } },
    { mount: { ...ready.mount, fstype: 'ext4' } },
    { mount: { ...ready.mount, options: 'rw,noquota' } },
    { mount: { ...ready.mount, options: 'ro,prjquota' } },
    { quotaState: 'Accounting: ON\nEnforcement: OFF' },
    { quotaState: 'Accounting: OFF\nEnforcement: ON' },
    { dockerHost: 'ssh://remote-host' },
  ])
    assert.ok(
      validateE2EEnvironment({ ...ready, ...patch }).length > 0,
      JSON.stringify(patch),
    );
});

test('explicit Docker context overrides a local DOCKER_HOST', () => {
  const endpoint = resolveDockerHost(
    { DOCKER_CONTEXT: 'remote', DOCKER_HOST: 'unix:///var/run/docker.sock' },
    (context) => {
      assert.equal(context, 'remote');
      return 'ssh://remote-host';
    },
  );
  assert.equal(endpoint, 'ssh://remote-host');
  assert.ok(
    validateE2EEnvironment({ ...ready, dockerHost: endpoint }).length > 0,
  );
  assert.equal(
    resolveDockerHost({ DOCKER_HOST: ready.dockerHost }, () => {
      assert.fail('no context lookup when only DOCKER_HOST is set');
    }),
    ready.dockerHost,
  );
  assert.equal(
    resolveDockerHost({}, (context) => {
      assert.equal(context, undefined);
      return ready.dockerHost;
    }),
    ready.dockerHost,
  );
});
