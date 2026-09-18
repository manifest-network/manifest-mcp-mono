import { describe, expect, it } from 'vitest';
import { serverFredCompatibility } from './compatibility.js';

describe('MCP Fred compatibility configuration', () => {
  it('defaults to v0.13 and accepts explicit environment modes', () => {
    expect(serverFredCompatibility(undefined, undefined)).toBe('v0.13');
    expect(serverFredCompatibility(undefined, ' v0.13 ')).toBe('v0.13');
    expect(serverFredCompatibility(undefined, 'pr240')).toBe('pr240');
  });

  it('accepts and snapshots a JSON provider URL map', () => {
    const result = serverFredCompatibility(
      undefined,
      '{"https://fred.example/":"pr240"}',
    );
    expect(result).toEqual({ 'https://fred.example': 'pr240' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('gives constructor configuration precedence over the environment', () => {
    expect(serverFredCompatibility('v0.13', 'pr240')).toBe('v0.13');
    expect(serverFredCompatibility('pr240', 'invalid JSON')).toBe('pr240');
  });

  it.each([
    '',
    '{',
    'latest',
    'null',
    '[]',
    '{"https://fred.example":"latest"}',
  ])('rejects invalid environment values: %s', (value) =>
    expect(() => serverFredCompatibility(undefined, value)).toThrow(),
  );
});
