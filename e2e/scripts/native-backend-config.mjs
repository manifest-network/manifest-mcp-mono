#!/usr/bin/env node
// Only filesystem locations change when the stateful backend moves to the host.
// The journal files stay in their existing named volume; never copy authority.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

export function nativeBackendConfig(sourceText, { backendData, sharedData }) {
  for (const directory of [backendData, sharedData]) {
    if (
      typeof directory !== 'string' ||
      !isAbsolute(directory) ||
      /[\r\n\0]/.test(directory)
    ) {
      throw new Error(
        'Native backend directories must be absolute filesystem paths',
      );
    }
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
  return stringify(config);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [source, destination, backendData, sharedData, ...extra] =
    process.argv.slice(2);
  if (!source || !destination || !backendData || !sharedData || extra.length) {
    throw new Error(
      'Usage: native-backend-config.mjs source destination backendData sharedData',
    );
  }
  const rendered = nativeBackendConfig(readFileSync(source, 'utf8'), {
    backendData,
    sharedData,
  });
  writeFileSync(destination, rendered, { mode: 0o600 });
  chmodSync(destination, 0o600);
}
