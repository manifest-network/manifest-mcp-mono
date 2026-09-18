import { describe, expect, it } from 'vitest';
import {
  type FredCompatibilityConfig,
  normalizeFredCompatibility,
  resolveFredCompatibility,
} from './compatibility.js';

describe('Fred compatibility selection', () => {
  it('defaults every unspecified provider to the released contract', () => {
    expect(normalizeFredCompatibility(undefined)).toBe('v0.13');
    expect(resolveFredCompatibility(undefined)).toBe('v0.13');
    expect(resolveFredCompatibility({}, 'https://unknown.example')).toBe(
      'v0.13',
    );
    expect(resolveFredCompatibility('pr240')).toBe('pr240');
  });

  it('snapshots and canonicalizes URL maps, preserving provider paths', () => {
    const input = { 'https://FRED.example:443/api/': 'pr240' as const };
    const config = normalizeFredCompatibility(input);
    delete (input as Partial<typeof input>)['https://FRED.example:443/api/'];
    expect(Object.isFrozen(config)).toBe(true);
    expect(resolveFredCompatibility(config, 'https://fred.example/api')).toBe(
      'pr240',
    );
    expect(resolveFredCompatibility(config, 'https://fred.example/other')).toBe(
      'v0.13',
    );
  });

  it('lets an explicit call override either configuration shape', () => {
    expect(resolveFredCompatibility('pr240', undefined, 'v0.13')).toBe('v0.13');
    expect(resolveFredCompatibility({}, undefined, 'pr240')).toBe('pr240');
  });

  it.each([
    null,
    [],
    13,
    'latest',
    { 'fred.example': 'pr240' },
    { 'ftp://fred.example': 'pr240' },
    { 'https://fred.example': 'latest' },
    { 'https://fred.example': 'pr240', 'https://fred.example/': 'v0.13' },
  ])('rejects invalid configuration %j', (value) => {
    expect(() =>
      normalizeFredCompatibility(value as FredCompatibilityConfig),
    ).toThrow();
  });

  it('requires a URL when resolving a map without a call override', () => {
    expect(() => resolveFredCompatibility({})).toThrow(
      'provider URL is required',
    );
  });
});
