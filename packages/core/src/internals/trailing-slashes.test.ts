import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from './trailing-slashes.js';

describe('trimTrailingSlashes', () => {
  it.each([
    ['https://faucet.test.com', 'https://faucet.test.com'],
    ['https://faucet.test.com/', 'https://faucet.test.com'],
    ['https://faucet.test.com///', 'https://faucet.test.com'],
    ['https://a.test//b//', 'https://a.test//b'],
    ['///', ''],
    ['', ''],
  ])('trims %j to %j', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected);
  });

  // CodeQL js/polynomial-redos: `/\/+$/` retries the slash run from every start position, so an
  // interior run of 100k slashes took ~5.7s; a linear scan is well under a millisecond.
  it('runs in linear time on a long interior slash run', () => {
    const input = `https://a.test/${'/'.repeat(100_000)}x`;
    const started = performance.now();
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
