import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOUNT_PATH = '/mnt/fred-xfs';

/** Pure validation used by the read-only preflight and its negative controls. */
export function validateE2EEnvironment({
  platform,
  mount,
  quotaState,
  dockerHost,
}) {
  const errors = [];
  if (platform !== 'linux')
    errors.push('Run the full E2E suite inside a Linux VM or Linux host.');
  if (mount?.target !== MOUNT_PATH || mount?.fstype !== 'xfs') {
    errors.push(
      `${MOUNT_PATH} must be a dedicated XFS mount on the Docker host.`,
    );
  }
  const options = mount?.options?.split(',') ?? [];
  if (
    !options.includes('rw') ||
    !options.some((option) => option === 'prjquota' || option === 'pquota')
  ) {
    errors.push(
      'The XFS mount must be read-write with project quotas (prjquota/pquota).',
    );
  }
  if (
    !quotaState?.match(/Accounting:\s+ON/) ||
    !quotaState?.match(/Enforcement:\s+ON/)
  ) {
    errors.push(
      'xfs_quota must report project Accounting: ON and Enforcement: ON.',
    );
  }
  if (dockerHost !== 'unix:///var/run/docker.sock') {
    errors.push(
      'Use the local Linux Docker daemon at unix:///var/run/docker.sock; the backend requires host-identical bind paths.',
    );
  }
  return errors;
}

/** Docker gives an explicit context precedence over DOCKER_HOST. */
export function resolveDockerHost(env, inspectContext) {
  if (env.DOCKER_CONTEXT) return inspectContext(env.DOCKER_CONTEXT);
  if (env.DOCKER_HOST) return env.DOCKER_HOST;
  return inspectContext();
}

export function checkE2EEnvironment() {
  const read = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const errors = [];
  let mount;
  let quotaState;
  let dockerHost;
  for (const probe of [
    () => {
      mount = JSON.parse(
        read('findmnt', [
          '--json',
          '--mountpoint',
          MOUNT_PATH,
          '--output',
          'TARGET,FSTYPE,OPTIONS',
        ]),
      ).filesystems?.[0];
    },
    () => {
      quotaState = read('xfs_quota', ['-x', '-c', 'state -p', MOUNT_PATH]);
    },
    () => {
      dockerHost = resolveDockerHost(process.env, (context) =>
        JSON.parse(
          read('docker', [
            'context',
            'inspect',
            '--format',
            '{{json .Endpoints.docker.Host}}',
            ...(context ? [context] : []),
          ]),
        ),
      );
      read('docker', ['info', '--format', '{{.ServerVersion}}']);
    },
  ]) {
    try {
      probe();
    } catch (error) {
      errors.push(
        `Read-only environment probe failed: ${error.message.split('\n')[0]}`,
      );
    }
  }
  return [
    ...errors,
    ...validateE2EEnvironment({
      platform: process.platform,
      mount,
      quotaState,
      dockerHost,
    }),
  ];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = checkE2EEnvironment();
  if (errors.length) {
    process.stderr.write(
      `${errors.map((error) => `- ${error}`).join('\n')}\nFollow docs/e2e-setup.md before starting Compose. No changes were made.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      'E2E environment is ready: local Linux Docker and writable XFS project quotas.\n',
    );
  }
}
