// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal CSI sequences.
const ANSI_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal OSC sequences.
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Remove terminal/format controls while preserving diagnostic newlines and tabs. */
export function stripTextControls(raw: string): string {
  return raw
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) =>
      ch === '\n' || ch === '\t' ? ch : '',
    );
}
