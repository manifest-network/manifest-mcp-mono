import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// publint/attw ask tsdown to spawn `npm pack`. npm writes to its cache even
// when the packed tarball itself is temporary, so restricted builders with a
// read-only home cache otherwise fail with EROFS (reported as exit code 226).
// This must run before tsdown loads: its packaging helper captures the process
// environment before evaluating tsdown.config.ts. Nested npm lifecycles also
// inject their default cache path, so retain a configured path only when its
// directory (or the nearest existing parent) is writable.
function hasWritableParent(cachePath) {
  let candidate = resolve(cachePath);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }

  try {
    if (!statSync(candidate).isDirectory()) return false;
    accessSync(candidate, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const configuredCache =
  process.env.NPM_CONFIG_CACHE ?? process.env.npm_config_cache;
const cache =
  configuredCache && hasWritableParent(configuredCache)
    ? configuredCache
    : join(tmpdir(), 'manifest-mcp-npm-cache');

// npm lowercases config variables for lifecycle children. Set both spellings so
// a nested `npm pack` cannot resurrect an inherited, read-only default.
process.env.npm_config_cache = cache;
process.env.NPM_CONFIG_CACHE = cache;

await import('tsdown/run');
