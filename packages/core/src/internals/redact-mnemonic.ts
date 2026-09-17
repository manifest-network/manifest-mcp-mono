import { stripTextControls } from './text-controls.js';

/** Existing whole-string heuristic, applied before operation prefixes hide the shape. */
export function redactPossibleMnemonic(value: string): string {
  const words = stripTextControls(value).trim().split(/\s+/);
  if (
    words.length >= 12 &&
    words.length <= 24 &&
    words.length % 3 === 0 &&
    words.every((word) => !!word.match(/^[a-z]+$/))
  ) {
    return '[REDACTED - possible mnemonic]';
  }
  return value;
}
