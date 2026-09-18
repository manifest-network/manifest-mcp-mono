import { stripTextControls } from './text-controls.js';

function isPossibleMnemonic(words: readonly string[]): boolean {
  return (
    words.length >= 12 &&
    words.length <= 24 &&
    words.length % 3 === 0 &&
    words.every((word) => !!word.match(/^[a-z]+$/))
  );
}

function redactText(value: string, removeControls: boolean): string {
  // Some whitespace separators are also removable controls (CR, VT, FF,
  // Unicode line/paragraph separators and BOM). Preserve their original word
  // boundaries before checking the visible, control-free candidate as well.
  const words = value.trim().split(/\s+/);
  // Stripping only deletes characters: it cannot increase the number of
  // whitespace-delimited words. Large single-token payloads need no more work.
  if (words.length < 12) {
    return removeControls ? stripTextControls(value) : value;
  }
  if (isPossibleMnemonic(words)) {
    return '[REDACTED - possible mnemonic]';
  }
  const visible = stripTextControls(value);
  // Ordinary diagnostics need only one word scan. Controls may remove whole
  // tokens, so a large original word count cannot exclude the visible candidate.
  if (visible !== value && isPossibleMnemonic(visible.trim().split(/\s+/))) {
    return '[REDACTED - possible mnemonic]';
  }
  return removeControls ? visible : value;
}

/** Existing whole-string heuristic, applied before operation prefixes hide the shape. */
export function redactPossibleMnemonic(value: string): string {
  return redactText(value, false);
}

/** Redact both mnemonic candidates, reusing the control-free text for model output. */
export function redactAndStripTextControls(value: string): string {
  return redactText(value, true);
}
