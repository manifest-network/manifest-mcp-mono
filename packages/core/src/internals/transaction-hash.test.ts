import { describe, expect, it, vi } from 'vitest';
import { isTransactionHash } from './transaction-hash.js';

describe('isTransactionHash', () => {
  it.each(['ab'.repeat(32), 'AB'.repeat(32), '0123456789aBcDeF'.repeat(4)])(
    'accepts exactly 64 ASCII hex characters: %s',
    (hash) => {
      expect(isTransactionHash(hash)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['short', 'a'.repeat(63)],
    ['long', 'a'.repeat(65)],
    ['non-hex ASCII', `${'a'.repeat(63)}g`],
    ['non-ASCII lookalike', `${'a'.repeat(63)}Ａ`],
    ['embedded NUL', `${'a'.repeat(31)}\0${'a'.repeat(32)}`],
    ['leading line break', `\n${'a'.repeat(64)}`],
    ...['\n', '\r', '\r\n', '\u2028', '\u2029', '\u200b', ' '].map((suffix) => [
      `suffix ${JSON.stringify(suffix)}`,
      'a'.repeat(64) + suffix,
    ]),
  ])('rejects %s', (_label, hash) => {
    expect(isTransactionHash(hash)).toBe(false);
  });

  it.each([null, undefined, 123, 123n, true, [], {}])(
    'rejects a non-string value: %s',
    (value) => {
      expect(isTransactionHash(value)).toBe(false);
    },
  );

  it('does not coerce objects into hash strings', () => {
    const stringify = vi.fn(() => 'a'.repeat(64));
    expect(isTransactionHash({ toString: stringify })).toBe(false);
    expect(stringify).not.toHaveBeenCalled();
  });
});
