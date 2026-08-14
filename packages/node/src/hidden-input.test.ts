import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { applyHiddenInputChunk, promptHidden } from './hidden-input.js';

// Control characters are written as escapes, never as literal glyphs: a raw
// control code point does not survive a round-trip through most editors and
// review tools, and a test for control-character handling that lost its control
// characters would pass vacuously.
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);
const BS = String.fromCharCode(8);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const LOCK = String.fromCodePoint(0x1f510);

/**
 * Folds a sequence of chunks the way the stdin listener does, so a test can
 * express "typed" (one chunk per character) and "pasted" (one chunk total) with
 * the same helper and compare them directly.
 */
function feed(chunks: readonly string[]): { value: string; status: string } {
  let value = '';
  for (const chunk of chunks) {
    const next = applyHiddenInputChunk(value, chunk);
    value = next.value;
    if (next.status !== 'reading') return { value, status: next.status };
  }
  return { value, status: 'reading' };
}

describe('applyHiddenInputChunk', () => {
  describe('ENG-668 Q-3 — a paste arrives as one chunk, not one keystroke', () => {
    it('treats a pasted password with a trailing CRLF as a submit, not as content', () => {
      // THE regression. A terminal delivers a paste as a single 'data' event.
      // The pre-fix reader compared the whole chunk against CR / LF, missed,
      // fell through to `ch >= ' '` (lexicographic on the first character) and
      // appended the entire string -- CR and LF included -- to the password.
      expect(applyHiddenInputChunk('', `hunter2${CR}${LF}`)).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });

    it('produces the same password whether typed or pasted', () => {
      const typed = feed([...'correct horse battery staple', CR]);
      const pasted = feed([`correct horse battery staple${CR}${LF}`]);

      expect(pasted).toEqual(typed);
      expect(pasted.value).toBe('correct horse battery staple');
      expect(pasted.status).toBe('submitted');
    });

    it('does not absorb a bare trailing LF (paste from a Unix clipboard)', () => {
      expect(applyHiddenInputChunk('', `hunter2${LF}`)).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });

    it('does not absorb a bare trailing CR', () => {
      expect(applyHiddenInputChunk('', `hunter2${CR}`)).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });

    it('discards anything following an in-chunk terminator', () => {
      // A multi-line paste must not smuggle its tail into the password.
      expect(applyHiddenInputChunk('', `hunter2${LF}rm -rf /`)).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });

    it('appends a chunk that carries no terminator and keeps reading', () => {
      expect(applyHiddenInputChunk('', 'hunter2')).toEqual({
        value: 'hunter2',
        status: 'reading',
      });
    });

    it('accumulates across chunk boundaries', () => {
      expect(feed(['hun', 'ter', `2${CR}`])).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });
  });

  describe('control characters', () => {
    it('drops C0 controls instead of absorbing them into key material', () => {
      // ESC is what an arrow key or a bracketed-paste marker delivers.
      // Absorbing it silently is the same class of corruption as the CRLF bug.
      expect(applyHiddenInputChunk('', `a${ESC}b`)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('drops a NUL without truncating the rest of the chunk', () => {
      expect(applyHiddenInputChunk('', `a${NUL}b`)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('reports Ctrl+C as interrupted, mid-chunk', () => {
      expect(applyHiddenInputChunk('', `abc${CTRL_C}def`)).toEqual({
        value: 'abc',
        status: 'interrupted',
      });
    });

    it('reports Ctrl+D as eof, mid-chunk', () => {
      expect(applyHiddenInputChunk('', `abc${CTRL_D}def`)).toEqual({
        value: 'abc',
        status: 'eof',
      });
    });

    it('keeps a literal space, which is a legal password character', () => {
      expect(applyHiddenInputChunk('', 'a b')).toEqual({
        value: 'a b',
        status: 'reading',
      });
    });
  });

  describe('backspace', () => {
    it('erases within a single chunk', () => {
      expect(applyHiddenInputChunk('', `abc${DEL}`)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('erases across a chunk boundary', () => {
      expect(applyHiddenInputChunk('abc', DEL)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('accepts backspace as well as DEL', () => {
      expect(applyHiddenInputChunk('abc', BS)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('is a no-op on an empty buffer', () => {
      expect(applyHiddenInputChunk('', DEL)).toEqual({
        value: '',
        status: 'reading',
      });
    });

    it('removes a whole non-BMP code point rather than half a surrogate pair', () => {
      // Splitting a surrogate pair would leave a lone surrogate in the
      // passphrase -- unrepresentable, and unequal to anything the user retypes.
      expect(applyHiddenInputChunk(`a${LOCK}`, DEL)).toEqual({
        value: 'a',
        status: 'reading',
      });
    });

    it('keeps a non-BMP code point that is not erased', () => {
      expect(applyHiddenInputChunk('', `a${LOCK}`)).toEqual({
        value: `a${LOCK}`,
        status: 'reading',
      });
    });
  });
});

/** Minimal stand-in for a raw-mode TTY stdin. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  rawMode = false;
  paused = false;
  setRawMode(v: boolean): this {
    this.rawMode = v;
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  setEncoding(): this {
    return this;
  }
}

describe('promptHidden', () => {
  function harness(): {
    stdin: FakeStdin;
    written: string[];
    call: (q?: string) => Promise<string>;
  } {
    const stdin = new FakeStdin();
    const written: string[] = [];
    const call = (q = 'Password: '): Promise<string> =>
      promptHidden(q, {
        stdin: stdin as unknown as NodeJS.ReadStream,
        write: (s: string) => written.push(s),
      });
    return { stdin, written, call };
  }

  it('resolves a single pasted chunk to the password without its terminator', async () => {
    const { stdin, written, call } = harness();
    const p = call();

    stdin.emit('data', `hunter2${CR}${LF}`);

    await expect(p).resolves.toBe('hunter2');
    expect(written[0]).toBe('Password: ');
  });

  it('restores the terminal out of raw mode after resolving', async () => {
    const { stdin, call } = harness();
    const p = call();

    expect(stdin.rawMode).toBe(true);
    stdin.emit('data', `pw${CR}`);
    await p;

    expect(stdin.rawMode).toBe(false);
    expect(stdin.paused).toBe(true);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('rejects on Ctrl+D rather than resolving with partial input', async () => {
    const { stdin, call } = harness();
    const p = call();

    stdin.emit('data', `partial${CTRL_D}`);

    await expect(p).rejects.toThrow(/closed before/i);
    expect(stdin.rawMode).toBe(false);
  });

  it('rejects on a stdin error and restores the terminal', async () => {
    const { stdin, call } = harness();
    const p = call();

    stdin.emit('error', new Error('boom'));

    await expect(p).rejects.toThrow(/boom/);
    expect(stdin.rawMode).toBe(false);
  });

  it('refuses to prompt when stdin is not a TTY', async () => {
    const { stdin, call } = harness();
    stdin.isTTY = false;

    await expect(call()).rejects.toThrow(/Interactive terminal required/);
  });
});
