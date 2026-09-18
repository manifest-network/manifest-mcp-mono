import { describe, expect, it } from 'vitest';
import { stripTextControls } from './text-controls.js';

describe('stripTextControls', () => {
  it.each([
    ['DEL', '\u007f'],
    ['NEL', '\u0085'],
    ['C1 CSI', '\u009b31m'],
    ['soft hyphen', '\u00ad'],
  ])('strips %s from otherwise printable ASCII', (_name, control) => {
    expect(stripTextControls(`before${control}after`)).toBe('beforeafter');
  });

  it('preserves printable ASCII and diagnostic layout across large bodies', () => {
    const value = `${Array.from({ length: 95 }, (_, index) =>
      String.fromCharCode(index + 32),
    ).join('')}\t\n`.repeat(10_000);
    expect(stripTextControls(value)).toBe(value);
  });

  it('matches Unicode control categories for every code point, except preserved tabs and newlines', () => {
    for (let start = 0; start <= 0x10ffff; start += 4096) {
      const text = String.fromCodePoint(
        ...Array.from(
          { length: Math.min(4096, 0x110000 - start) },
          (_, index) => start + index,
        ),
      );
      const expected = text.replace(
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
        (character) =>
          character === '\n' || character === '\t' ? character : '',
      );
      expect(stripTextControls(text)).toBe(expected);
    }
  });

  it('strips ANSI CSI and OSC sequences while preserving diagnostic layout and non-control Unicode', () => {
    expect(
      stripTextControls(
        '\u001b[31mred\u009b0m\t\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u0007\n\u202eé😀\u202c',
      ),
    ).toBe('red\tlink\né😀');
  });
});
