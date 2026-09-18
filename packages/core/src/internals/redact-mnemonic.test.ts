import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import {
  sanitizeForLogging,
  sanitizeForModelText,
  withErrorHandling,
} from '../server-utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { redactPossibleMnemonic } from './redact-mnemonic.js';

const words =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';
const redacted = '[REDACTED - possible mnemonic]';
const candidates = [
  ...[
    ['space', ' '],
    ['tab', '\t'],
    ['LF', '\n'],
    ['CR', '\r'],
    ['VT', '\v'],
    ['FF', '\f'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['BOM', '\ufeff'],
  ].map(([name, separator]) => [name, words.split(' ').join(separator)]),
  ['ANSI', `\u001b[31m${words}\u001b[0m`],
  ['bidi', `\u202e${words}\u202c`],
  ['controls inside words', words.replace(/a/g, 'a\u200b')],
  [
    'OSC containing more than 24 words',
    `\u001b]${'window title '.repeat(15)}\u0007${words}`,
  ],
];

describe('mnemonic redaction retains whitespace tokenization', () => {
  it.each(candidates)(
    'redacts %s at helper and public text sinks',
    (_name, message) => {
      expect(redactPossibleMnemonic(message)).toBe(redacted);
      expect(sanitizeForLogging(message)).toBe(redacted);
      expect(sanitizeForModelText(message)).toBe(redacted);
    },
  );

  for (const kind of ['native', 'SDK'] as const) {
    it.each(candidates)(
      `${kind} %s is redacted in actual stderr and MCP response`,
      async (_name, message) => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const error =
            kind === 'SDK'
              ? new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, message)
              : new Error(message);
          const handler = withErrorHandling<() => Promise<CallToolResult>>(
            'read',
            async () => {
              throw error;
            },
          );
          const result = await handler();
          const payload = JSON.parse(
            (result.content[0] as { text: string }).text,
          );
          expect(result.isError).toBe(true);
          expect(payload.message).toBe(redacted);
          const logged = log.mock.calls.flat().join('\n');
          expect(logged).toContain(redacted);
          expect(logged).not.toContain('abandon');
          expect(logged).not.toContain('accident');
          // Native stacks contain the original message; a redacted message must
          // suppress that stack, not merely redact the first log line.
          expect(logged).not.toContain('Error:');
        } finally {
          log.mockRestore();
        }
      },
    );
  }

  it.each([
    '',
    'ordinary diagnostic text',
    'eleven words in this sentence should not be treated as secrets',
    `${words}!`,
    `context: ${words}`,
    '\u001b[31mHTTP 503\u001b[0m',
  ])('preserves non-mnemonic input %j', (value) => {
    expect(redactPossibleMnemonic(value)).toBe(value);
  });
});

describe('mnemonic redaction output equivalence', () => {
  // The contract is the union of the raw whitespace-delimited candidate and
  // the terminal/control-free candidate. Keep a declarative reference here
  // so fast paths cannot silently drop either interpretation.
  function reference(value: string, removeControls = false): string {
    const visible = value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reference ANSI CSI stripping.
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reference ANSI OSC stripping.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
        character === '\n' || character === '\t' ? character : '',
      );
    return [value, visible].some((candidate) =>
      candidate
        .trim()
        .match(/^[a-z]+(?:\s+[a-z]+){11}(?:(?:\s+[a-z]+){3}){0,4}$/),
    )
      ? redacted
      : removeControls
        ? visible
        : value;
  }

  it('retains both interpretations across word counts, controls and terminal sequences', () => {
    const separators = [
      ' ',
      '\t',
      '\n',
      '\r',
      '\v',
      '\f',
      '\u0085',
      '\u00a0',
      '\u2003',
      '\u200b',
      '\u2028',
      '\u2029',
      '\ufeff',
      '\u001b[0m ',
    ];
    const wrappers = [
      ['', ''],
      ['\u001b[31m', '\u001b[0m'],
      ['\u202e', '\u202c'],
      [`\u001b]${'title '.repeat(30)}\u0007`, ''],
      ['\u001b]8;;https://example.com\u001b\\', '\u001b]8;;\u0007'],
      ['context: ', ''],
      ['', '!'],
    ];
    for (let count = 0; count <= 30; count++) {
      for (const separator of separators) {
        for (const [prefix, suffix] of wrappers) {
          const value = `${prefix}${Array(count).fill('abandon').join(separator)}${suffix}`;
          expect(redactPossibleMnemonic(value), JSON.stringify(value)).toBe(
            reference(value),
          );
          expect(
            sanitizeForModelText(value, value.length),
            JSON.stringify(value),
          ).toBe(reference(value, true));
        }
      }
    }
  });

  it('preserves a deterministic corpus of ordinary ASCII and Unicode diagnostics', () => {
    const corpus = [
      'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXl6'.repeat(20_000),
      JSON.stringify({ items: Array(5000).fill({ id: 42, status: 'ready' }) }),
      'The provider returned HTTP 503 while handling the deployment.\n'.repeat(
        5000,
      ),
      'Réponse du fournisseur : indisponible. 日本語の診断。 😀\n'.repeat(5000),
      ...Array.from({ length: 128 }, (_, code) =>
        words.replace(/a/g, `a${String.fromCharCode(code)}`),
      ),
    ];
    for (const value of corpus) {
      expect(redactPossibleMnemonic(value)).toBe(reference(value));
      expect(sanitizeForModelText(value, value.length)).toBe(
        reference(value, true),
      );
    }
  });
});
