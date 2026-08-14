import { EOL } from 'node:os';

/**
 * Hidden (no-echo) terminal input for passwords and mnemonics.
 *
 * Split out of `keygen.ts` by ENG-668. The defect this replaces was a raw-mode
 * `'data'` listener whose parameter was named and treated as a single keystroke.
 * Node delivers a **chunk**: a paste (and fast typing, and a multi-byte key)
 * arrives as one event carrying many characters. Every terminator comparison
 * therefore missed, and the catch-all `ch >= ' '` branch -- a lexicographic
 * comparison on the chunk's *first* character -- appended the whole string,
 * embedded CR/LF included, to the secret.
 *
 * The classification is a pure fold so it can be tested directly, without
 * standing up a TTY. That testability is the point: the old shape had no unit
 * coverage at all, which is why a wallet-corruption path survived in it.
 */

// Written as code points rather than escape literals: a control character in
// source is invisible to review and does not survive every editor round-trip.
const CTRL_C = 3;
const CTRL_D = 4;
const BACKSPACE = 8;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const DELETE = 127;

const ESCAPE = 27;
const CSI_INTRODUCER = 0x5b; // '['
const SS3_INTRODUCER = 0x4f; // 'O'

export type HiddenInputStatus = 'reading' | 'submitted' | 'eof' | 'interrupted';

/**
 * Where the ANSI escape-sequence parser sits between chunks.
 *
 * `none` is normal text. `esc` means an ESC byte was seen and the sequence type
 * is not yet known. `csi` is an `ESC [` control sequence — arrow keys, and the
 * `ESC [200~` / `ESC [201~` bracketed-paste markers. `ss3` is an `ESC O`
 * sequence (function keys), whose next byte is its last.
 */
export type EscapeMode = 'none' | 'esc' | 'csi' | 'ss3';

export interface HiddenInputState {
  /** The secret accumulated so far, with terminators and controls removed. */
  readonly value: string;
  /** What the caller should do next. Anything but `reading` ends the prompt. */
  readonly status: HiddenInputStatus;
  /**
   * Parser carry-over. A terminal may split an escape sequence across `'data'`
   * events, so the caller must feed this back with the next chunk — otherwise
   * the tail of a split sequence is read as ordinary text and lands in the
   * secret.
   */
  readonly escape: EscapeMode;
}

/**
 * Advance the escape-sequence parser by one byte and return the next mode.
 *
 * A CSI sequence is parameter bytes (`0x30-0x3F`) and intermediate bytes
 * (`0x20-0x2F`) terminated by a final byte (`0x40-0x7E`), so `ESC [ 2 0 0 ~`
 * and `ESC [ 1 ; 2 D` each end exactly where they should.
 */
function advanceEscape(mode: EscapeMode, code: number): EscapeMode {
  if (mode === 'esc') {
    if (code === CSI_INTRODUCER) return 'csi';
    if (code === SS3_INTRODUCER) return 'ss3';
    return 'none'; // two-byte sequence (e.g. Alt+key); this byte was its last
  }
  if (mode === 'ss3') return 'none'; // exactly one byte follows ESC O
  return code >= 0x40 && code <= 0x7e ? 'none' : 'csi';
}

/**
 * Fold one stdin chunk into the accumulated buffer.
 *
 * Characters are iterated by **code point**, so an astral character (emoji) is
 * one editable unit and a backspace can never split a surrogate pair.
 *
 * A terminator ends the read immediately and everything after it *in the same
 * chunk* is discarded — a multi-line paste must not smuggle its tail into the
 * secret.
 *
 * Escape sequences are consumed **whole**. Dropping the lone ESC byte is not
 * enough: the rest of the sequence is printable, so an arrow key would append
 * `[A` and a bracketed paste would wrap the secret in `[200~` … `[201~`. Pass
 * the previous result's `escape` back in so a sequence split across two chunks
 * is still consumed as one.
 */
export function applyHiddenInputChunk(
  value: string,
  chunk: string,
  escapeMode: EscapeMode = 'none',
): HiddenInputState {
  let next = value;
  let mode = escapeMode;

  for (const ch of chunk) {
    const code = ch.codePointAt(0) ?? 0;

    if (mode !== 'none') {
      // A C0 control cannot appear inside a well-formed sequence. Treat it as
      // the terminal having sent something this parser does not model, abandon
      // the sequence, and handle the byte normally -- so Ctrl+C and Ctrl+D stay
      // responsive even after a malformed or truncated escape.
      if (code >= SPACE) {
        mode = advanceEscape(mode, code);
        continue;
      }
      mode = 'none';
    }

    if (code === CARRIAGE_RETURN || code === LINE_FEED) {
      return { value: next, status: 'submitted', escape: 'none' };
    }
    if (code === CTRL_D) return { value: next, status: 'eof', escape: 'none' };
    if (code === CTRL_C) {
      return { value: next, status: 'interrupted', escape: 'none' };
    }

    if (code === ESCAPE) {
      mode = 'esc';
      continue;
    }

    if (code === DELETE || code === BACKSPACE) {
      next = [...next].slice(0, -1).join('');
      continue;
    }

    if (code >= SPACE) {
      next += ch;
    }

    // Every remaining C0 control (NUL, TAB, ...) is DROPPED rather than
    // appended. It cannot be part of a passphrase the user is able to retype,
    // so absorbing it silently is exactly the ENG-668 corruption -- the keyfile
    // ends up encrypted under a secret its owner cannot reproduce, and the
    // mismatch only surfaces at the next startup.
  }

  return { value: next, status: 'reading', escape: mode };
}

export interface PromptHiddenDeps {
  /** Defaults to `process.stdin`. Injectable so the prompt is testable. */
  readonly stdin?: NodeJS.ReadStream;
  /** Defaults to writing the prompt to stderr. */
  readonly write?: (chunk: string) => void;
}

/**
 * Prompt on stderr and read a secret without echoing it.
 *
 * Rejects (rather than throwing synchronously) on a non-TTY stdin so every
 * failure mode is observable through the returned promise.
 */
export function promptHidden(
  question: string,
  deps: PromptHiddenDeps = {},
): Promise<string> {
  const stdin = deps.stdin ?? process.stdin;
  const write =
    deps.write ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    });

  if (!stdin.isTTY) {
    return Promise.reject(
      new Error(
        'Interactive terminal required for key management commands. Cannot prompt for input in non-interactive mode.',
      ),
    );
  }

  return new Promise<string>((resolve, reject) => {
    let value = '';
    // Carried between events: a terminal can split an escape sequence across
    // two 'data' chunks, and without this the tail reads as ordinary text.
    let escapeMode: EscapeMode = 'none';
    let settled = false;

    write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      write(EOL);
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(new Error(`stdin error during password prompt: ${err.message}`));
    };

    const onData = (chunk: string): void => {
      const state = applyHiddenInputChunk(value, chunk, escapeMode);
      value = state.value;
      escapeMode = state.escape;

      switch (state.status) {
        case 'reading':
          return;
        case 'submitted':
          cleanup();
          resolve(value);
          return;
        case 'eof':
          cleanup();
          reject(new Error('Input stream closed before input was entered.'));
          return;
        case 'interrupted':
          cleanup();
          process.exit(130);
      }
    };

    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}
