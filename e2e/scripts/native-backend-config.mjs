#!/usr/bin/env node
// Only filesystem locations change when the stateful backend moves to the host.
// The journal files stay in their existing named volume; never copy authority.
// The image store is also a host property: Fred refuses every containerd image
// admission without the daemon's actual content root, so this renderer derives
// image_data_path from `docker info` instead of the container-visible config.
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

// Docker packages start dockerd with --containerd=/run/containerd/containerd.sock;
// that system containerd keeps content and snapshots under its default root.
const SYSTEM_CONTAINERD_ROOTS = new Map([
  ['/run/containerd/containerd.sock', '/var/lib/containerd'],
  ['/var/run/containerd/containerd.sock', '/var/lib/containerd'],
]);

function requireAbsolutePath(path, message) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) {
    throw new Error(message);
  }
}

/** Mirrors Fred's daemonUsesContainerd (internal/backend/docker/image_capacity.go). */
export function daemonUsesContainerd(info) {
  if (String(info.Driver ?? '').includes('snapshotter')) return true;
  return (
    Array.isArray(info.DriverStatus) &&
    info.DriverStatus.some(
      (status) =>
        Array.isArray(status) &&
        status.length === 2 &&
        String(status[1]).includes('containerd'),
    )
  );
}

/**
 * Returns Fred's image_data_path for this daemon, or undefined for classic
 * overlay2, whose DockerRootDir Fred accounts by itself. Refuses the image
 * stores that Fred's requireBoundedImageStore rejects at backend startup.
 */
export function imageDataPath(info, override = '') {
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    throw new Error('Expected Docker daemon information');
  }
  const containerd = daemonUsesContainerd(info);
  if (
    !(info.Driver === 'overlay2' && !containerd) &&
    !(info.Driver === 'overlayfs' && containerd)
  ) {
    throw new Error(
      `Fred's bounded image import requires classic overlay2 or the containerd overlayfs snapshotter; Docker reports ${JSON.stringify(info.Driver)}`,
    );
  }
  if (override) {
    requireAbsolutePath(
      override,
      'FRED_IMAGE_DATA_PATH must be an absolute filesystem path',
    );
    return override;
  }
  if (!containerd) return undefined;
  const root = SYSTEM_CONTAINERD_ROOTS.get(info.Containerd?.Address);
  if (!root) {
    throw new Error(
      `Docker's containerd image store uses ${JSON.stringify(info.Containerd?.Address ?? 'an unreported containerd')}; set FRED_IMAGE_DATA_PATH to that containerd root directory`,
    );
  }
  return root;
}

export function nativeBackendConfig(
  sourceText,
  { backendData, sharedData, dockerInfo, imageDataPathOverride = '' },
) {
  for (const directory of [backendData, sharedData]) {
    requireAbsolutePath(
      directory,
      'Native backend directories must be absolute filesystem paths',
    );
  }
  const config = parse(sourceText);
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Expected a backend configuration object');
  }
  for (const [field, prefix, directory] of [
    ['tls_cert_file', '/shared/', sharedData],
    ['tls_key_file', '/shared/', sharedData],
    ['callback_db_path', '/data/', backendData],
    ['diagnostics_db_path', '/data/', backendData],
    ['releases_db_path', '/data/', backendData],
    ['retention_db_path', '/data/', backendData],
  ]) {
    const path = config[field];
    if (
      typeof path !== 'string' ||
      !path.startsWith(prefix) ||
      path.slice(prefix.length).split('/').includes('..')
    ) {
      throw new Error(`Expected ${field} under ${prefix}`);
    }
    config[field] = join(directory, path.slice(prefix.length));
  }
  if (Object.hasOwn(config, 'image_data_path')) {
    throw new Error(
      'image_data_path is host-specific; set FRED_IMAGE_DATA_PATH instead',
    );
  }
  const imageData = imageDataPath(dockerInfo, imageDataPathOverride);
  if (imageData !== undefined) config.image_data_path = imageData;
  return stringify(config);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [source, destination, backendData, sharedData, dockerInfo, ...extra] =
    process.argv.slice(2);
  if (
    !source ||
    !destination ||
    !backendData ||
    !sharedData ||
    !dockerInfo ||
    extra.length
  ) {
    throw new Error(
      'Usage: native-backend-config.mjs source destination backendData sharedData dockerInfoJson',
    );
  }
  const rendered = nativeBackendConfig(readFileSync(source, 'utf8'), {
    backendData,
    sharedData,
    dockerInfo: JSON.parse(readFileSync(dockerInfo, 'utf8')),
    imageDataPathOverride: process.env.FRED_IMAGE_DATA_PATH ?? '',
  });
  const imageData = parse(rendered).image_data_path;
  // Fred only samples this path at admission; refuse a missing root at startup.
  if (
    imageData !== undefined &&
    !statSync(imageData, { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new Error(
      `image_data_path ${imageData} is not a directory on this host`,
    );
  }
  writeFileSync(destination, rendered, { mode: 0o600 });
  chmodSync(destination, 0o600);
}
