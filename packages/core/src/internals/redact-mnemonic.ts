import { stripTextControls } from './text-controls.js';

function isPossibleMnemonic(value: string): boolean {
  const words = value.trim().split(/\s+/);
  return (
    words.length >= 12 &&
    words.length <= 24 &&
    words.length % 3 === 0 &&
    words.every((word) => !!word.match(/^[a-z]+$/))
  );
}

/** Existing whole-string heuristic, applied before operation prefixes hide the shape. */
export function redactPossibleMnemonic(value: string): string {
  // Some whitespace separators are also removable controls (CR, VT, FF,
  // Unicode line/paragraph separators and BOM). Preserve their original word
  // boundaries before checking the visible, control-free candidate as well.
  if (
    isPossibleMnemonic(value) ||
    isPossibleMnemonic(stripTextControls(value))
  ) {
    return '[REDACTED - possible mnemonic]';
  }
  return value;
}
