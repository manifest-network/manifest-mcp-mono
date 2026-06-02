import { ManifestMCPError } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import { FRED_FETCH_GUARDED_ENV, resolveGuardedFetch } from './fetch-gate.js';

// The guard's actual blocking behavior (private/reserved ranges, DNS
// rebinding) is covered by core's guarded-fetch.test.ts. This suite covers
// fred's wiring: which fetch the server injects given the env + runtime.
describe('resolveGuardedFetch (ENG-268 SSRF guard gate)', () => {
  it('default (env unset) + Node → a guarded fetch (not globalThis.fetch)', () => {
    const fetchFn = resolveGuardedFetch(undefined, true);
    expect(typeof fetchFn).toBe('function');
    expect(fetchFn).not.toBe(globalThis.fetch);
  });

  it('explicit truthy values + Node → a guarded fetch function', () => {
    for (const v of ['1', 'true', 'yes', 'on']) {
      expect(typeof resolveGuardedFetch(v, true)).toBe('function');
    }
  });

  it('opt-out (falsy) → undefined (HTTP layer uses globalThis.fetch)', () => {
    for (const v of ['0', 'false', 'no', 'off']) {
      expect(resolveGuardedFetch(v, true)).toBeUndefined();
    }
  });

  it('guard on but non-Node runtime → undefined (fall back, do not throw)', () => {
    expect(resolveGuardedFetch(undefined, false)).toBeUndefined();
    expect(resolveGuardedFetch('1', false)).toBeUndefined();
  });

  it('unrecognized env value → throws INVALID_CONFIG naming the env var', () => {
    let err: unknown;
    try {
      resolveGuardedFetch('ture', true);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ManifestMCPError);
    expect((err as ManifestMCPError).code).toBe('INVALID_CONFIG');
    expect((err as ManifestMCPError).message).toContain(FRED_FETCH_GUARDED_ENV);
  });
});
