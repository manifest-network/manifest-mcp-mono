// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal CSI sequences.
const ANSI_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal OSC sequences.
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// Cc consists of C0/C1; exclude tab and LF without invoking a replacement
// callback for every control in a potentially large diagnostic.
const TEXT_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip controls except diagnostic tabs and newlines.
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu;
// Most diagnostics are printable ASCII plus layout. Avoid Unicode-category
// scans on large ordinary strings; all other code units take the full path.
const NEEDS_CONTROL_SCAN = /[^\t\n\u0020-\u007e]/;

/** Remove terminal/format controls while preserving diagnostic newlines and tabs. */
export function stripTextControls(raw: string): string {
  if (!raw.match(NEEDS_CONTROL_SCAN)) return raw;
  return raw
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    .replace(TEXT_CONTROLS, '');
}
