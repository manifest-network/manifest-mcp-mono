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

export type HiddenInputStatus = 'reading' | 'submitted' | 'eof' | 'interrupted';

export interface HiddenInputState {
  /** The secret accumulated so far, with terminators and controls removed. */
  readonly value: string;
  /** What the caller should do next. Anything but `reading` ends the prompt. */
  readonly status: HiddenInputStatus;
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
 */
export function applyHiddenInputChunk(
  value: string,
  chunk: string,
): HiddenInputState {
  let next = value;

  for (const ch of chunk) {
    const code = ch.codePointAt(0) ?? 0;

    if (code === CARRIAGE_RETURN || code === LINE_FEED) {
      return { value: next, status: 'submitted' };
    }
    if (code === CTRL_D) return { value: next, status: 'eof' };
    if (code === CTRL_C) return { value: next, status: 'interrupted' };

    if (code === DELETE || code === BACKSPACE) {
      next = [...next].slice(0, -1).join('');
      continue;
    }

    if (code >= SPACE) {
      next += ch;
    }

    // Every remaining C0 control (NUL, ESC, TAB, the bracketed-paste markers)
    // is DROPPED rather than appended. It cannot be part of a passphrase the
    // user is able to retype, so absorbing it silently is exactly the ENG-668
    // corruption -- the keyfile ends up encrypted under a secret its owner
    // cannot reproduce, and the mismatch only surfaces at the next startup.
  }

  return { value: next, status: 'reading' };
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
      const state = applyHiddenInputChunk(value, chunk);
      value = state.value;

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
