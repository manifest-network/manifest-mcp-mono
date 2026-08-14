import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  applyHiddenInputChunk,
  type EscapeMode,
  promptHidden,
} from './hidden-input.js';

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
const VT = String.fromCharCode(11); // vertical tab: a C0 control that starts nothing
const LOCK = String.fromCodePoint(0x1f510);

/**
 * Folds a sequence of chunks the way the stdin listener does, so a test can
 * express "typed" (one chunk per character) and "pasted" (one chunk total) with
 * the same helper and compare them directly.
 */
/** Projects the two fields the legacy assertions pin; `escape` is carry-over. */
function fold(
  value: string,
  chunk: string,
  escapeMode: EscapeMode = 'none',
): { value: string; status: string } {
  const r = applyHiddenInputChunk(value, chunk, escapeMode);
  return { value: r.value, status: r.status };
}

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
      expect(fold('', `hunter2${CR}${LF}`)).toEqual({
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
      expect(fold('', `hunter2${LF}`)).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });

    it('does not absorb a bare trailing CR', () => {
      expect(fold('', `hunter2${CR}`)).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });

    it('discards anything following an in-chunk terminator', () => {
      // A multi-line paste must not smuggle its tail into the password.
      expect(fold('', `hunter2${LF}rm -rf /`)).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });

    it('appends a chunk that carries no terminator and keeps reading', () => {
      expect(fold('', 'hunter2')).toEqual({
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
      // A stray control byte cannot be part of a passphrase the user can
      // retype, so absorbing it is the same class of corruption as the CRLF
      // bug. ESC is deliberately NOT used here -- it introduces a sequence
      // whose remaining bytes must also be consumed, which is covered by the
      // escape-sequence block below.
      expect(fold('', `a${VT}b`)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('drops a NUL without truncating the rest of the chunk', () => {
      expect(fold('', `a${NUL}b`)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('reports Ctrl+C as interrupted, mid-chunk', () => {
      expect(fold('', `abc${CTRL_C}def`)).toEqual({
        value: 'abc',
        status: 'interrupted',
      });
    });

    it('reports Ctrl+D as eof, mid-chunk', () => {
      expect(fold('', `abc${CTRL_D}def`)).toEqual({
        value: 'abc',
        status: 'eof',
      });
    });

    it('keeps a literal space, which is a legal password character', () => {
      expect(fold('', 'a b')).toEqual({
        value: 'a b',
        status: 'reading',
      });
    });
  });

  describe('ANSI escape sequences are consumed whole (PR #176 review)', () => {
    // Dropping the lone ESC byte is not enough: the rest of a sequence is
    // printable. The first version of this fix appended `[A` for an arrow key
    // and wrapped a paste in `[200~` ... `[201~` -- silently corrupting key
    // material, which is the exact failure ENG-668 exists to prevent. It was
    // also a REGRESSION: the pre-ENG-668 reader compared the whole chunk
    // against `>= ' '`, so an ESC-leading chunk failed that test and was
    // dropped entirely.
    it('discards an arrow key instead of appending its final byte', () => {
      expect(fold('', `${ESC}[A`)).toEqual({ value: '', status: 'reading' });
    });

    it('discards an arrow key pressed mid-password', () => {
      expect(fold('', `pw${ESC}[Dx`)).toEqual({
        value: 'pwx',
        status: 'reading',
      });
    });

    it('discards bracketed-paste markers around the pasted text', () => {
      expect(fold('', `${ESC}[200~hunter2${ESC}[201~`)).toEqual({
        value: 'hunter2',
        status: 'reading',
      });
    });

    it('submits a bracketed paste that ends with CR, markers removed', () => {
      expect(fold('', `${ESC}[200~hunter2${ESC}[201~${CR}`)).toEqual({
        value: 'hunter2',
        status: 'submitted',
      });
    });

    it('discards a multi-parameter CSI sequence (e.g. Shift+Left)', () => {
      expect(fold('', `a${ESC}[1;2Db`)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('discards an SS3 function-key sequence', () => {
      expect(fold('', `a${ESC}OPb`)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('discards a two-byte ESC sequence (Alt+key)', () => {
      expect(fold('', `a${ESC}bc`)).toEqual({
        value: 'ac',
        status: 'reading',
      });
    });

    it('carries an unfinished sequence across a chunk boundary', () => {
      // The terminal is free to flush `ESC [` and `A` as two 'data' events.
      const first = applyHiddenInputChunk('', `pw${ESC}[`);
      expect(first).toEqual({ value: 'pw', status: 'reading', escape: 'csi' });

      const second = applyHiddenInputChunk(first.value, 'A', first.escape);
      expect(second).toEqual({
        value: 'pw',
        status: 'reading',
        escape: 'none',
      });
    });

    it('carries a bare trailing ESC across a chunk boundary', () => {
      const first = applyHiddenInputChunk('', `pw${ESC}`);
      expect(first.escape).toBe('esc');

      const second = applyHiddenInputChunk(first.value, '[A', first.escape);
      expect(second).toEqual({
        value: 'pw',
        status: 'reading',
        escape: 'none',
      });
    });

    it('keeps Ctrl+C responsive after a truncated escape sequence', () => {
      // A C0 control cannot appear inside a well-formed sequence, so the parser
      // abandons the sequence rather than swallowing the interrupt.
      expect(fold('', `${ESC}[${CTRL_C}`)).toEqual({
        value: '',
        status: 'interrupted',
      });
    });

    it('keeps CR responsive after a truncated escape sequence', () => {
      expect(fold('', `pw${ESC}[${CR}`)).toEqual({
        value: 'pw',
        status: 'submitted',
      });
    });

    it('reports escape: none for ordinary text', () => {
      expect(applyHiddenInputChunk('', 'pw').escape).toBe('none');
    });
  });

  describe('backspace', () => {
    it('erases within a single chunk', () => {
      expect(fold('', `abc${DEL}`)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('erases across a chunk boundary', () => {
      expect(fold('abc', DEL)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('accepts backspace as well as DEL', () => {
      expect(fold('abc', BS)).toEqual({
        value: 'ab',
        status: 'reading',
      });
    });

    it('is a no-op on an empty buffer', () => {
      expect(fold('', DEL)).toEqual({
        value: '',
        status: 'reading',
      });
    });

    it('removes a whole non-BMP code point rather than half a surrogate pair', () => {
      // Splitting a surrogate pair would leave a lone surrogate in the
      // passphrase -- unrepresentable, and unequal to anything the user retypes.
      expect(fold(`a${LOCK}`, DEL)).toEqual({
        value: 'a',
        status: 'reading',
      });
    });

    it('keeps a non-BMP code point that is not erased', () => {
      expect(fold('', `a${LOCK}`)).toEqual({
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

  it('strips an escape sequence split across two data events', async () => {
    // The end-to-end version of the carry-over case: promptHidden must feed the
    // parser state back, or the tail of a split sequence lands in the secret.
    const { stdin, call } = harness();
    const p = call();

    stdin.emit('data', `hun${ESC}[`);
    stdin.emit('data', `Dter2${CR}`);

    await expect(p).resolves.toBe('hunter2');
  });

  it('strips a bracketed paste delivered as one event', async () => {
    const { stdin, call } = harness();
    const p = call();

    stdin.emit('data', `${ESC}[200~hunter2${ESC}[201~${CR}`);

    await expect(p).resolves.toBe('hunter2');
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
