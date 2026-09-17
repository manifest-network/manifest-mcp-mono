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
