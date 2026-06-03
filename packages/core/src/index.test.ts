import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';

/**
 * The Node-only SSRF guard symbols that must NOT leak into the universal
 * barrel. `internals/guarded-fetch.ts` dynamic-imports `undici` (which pulls
 * `node:async_hooks`, unavailable in browsers). If the barrel re-exports from
 * that module, bundlers (rspack/webpack/vite) drag `undici` into the static
 * module graph and any browser consumer importing
 * `@manifest-network/manifest-mcp-core` fails to build (ENG-281). The guard is
 * exposed at the Node-only `./guarded-fetch` subpath instead.
 */
const GUARDED_FETCH_EXPORTS = [
  'createGuardedFetch',
  'isBlocked',
  'BLOCKED_RANGES_IPV4',
  'BLOCKED_RANGES_IPV6',
] as const;

describe('core barrel — guarded-fetch kept out (browser bundle safety, ENG-281)', () => {
  it.each(
    GUARDED_FETCH_EXPORTS,
  )('does not re-export %s from the main barrel', (name) => {
    expect(name in barrel).toBe(false);
  });
});

describe('core/guarded-fetch subpath entry (ENG-281)', () => {
  it('exposes the Node-only SSRF guard surface', async () => {
    const entry = await import('./guarded-fetch.js');
    expect(typeof entry.createGuardedFetch).toBe('function');
    expect(typeof entry.isBlocked).toBe('function');
    expect(Array.isArray(entry.BLOCKED_RANGES_IPV4)).toBe(true);
    expect(Array.isArray(entry.BLOCKED_RANGES_IPV6)).toBe(true);
  });
});

describe('package.json exports — guarded-fetch subpath (ENG-281)', () => {
  it('maps ./guarded-fetch to the built Node-only entry', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

    const subpath = pkg.exports?.['./guarded-fetch'];
    expect(subpath).toBeDefined();
    expect(subpath.node).toBe('./dist/guarded-fetch.js');
    expect(subpath.types).toBe('./dist/guarded-fetch.d.ts');
  });

  it('no longer re-exports the guard from the "." barrel build', () => {
    // The "." entry stays a single isomorphic file; the guard symbols only
    // resolve via the dedicated Node-only subpath above.
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    expect(pkg.exports?.['.'].import).toBe('./dist/index.js');
  });
});
