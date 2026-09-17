import {
  type jsonResponse,
  ManifestMCPError,
  ManifestMCPErrorCode,
  withErrorHandling,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it, vi } from 'vitest';
import { contextualError } from './error-diagnostics.js';

const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('contextual error redaction', () => {
  it.each([
    ['plain', mnemonic],
    ['ANSI', `\u001b[31m${mnemonic}\u001b[0m`],
    ['bidi', `\u202e${mnemonic}\u202c`],
  ])(
    'redacts a %s mnemonic before attribution can hide it',
    async (_name, message) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const original = Object.defineProperty(
        new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, message),
        'code',
        {
          get() {
            throw new Error('Cannot inspect code');
          },
        },
      );
      try {
        const normalized = contextualError(
          original,
          ManifestMCPErrorCode.TX_FAILED,
          'retry_set_domain failed to resolve provider for lease paid-lease: ',
        );
        const handler = withErrorHandling<
          () => Promise<ReturnType<typeof jsonResponse>>
        >('deploy_app', async () => {
          throw normalized;
        });
        const result = await handler();
        const parsed = JSON.parse((result.content[0] as { text: string }).text);
        expect(parsed.message).not.toContain(mnemonic);
        expect(parsed.message).toBe(
          'retry_set_domain failed to resolve provider for lease paid-lease: [REDACTED - possible mnemonic]',
        );
        expect(normalized.message).toBe(parsed.message);
        expect(normalized.code).toBe(ManifestMCPErrorCode.TX_FAILED);
        expect(
          Object.getOwnPropertyDescriptor(normalized, 'cause')?.value,
        ).toBe(original);
        expect(log.mock.calls.flat().join('\n')).not.toContain(mnemonic);
      } finally {
        log.mockRestore();
      }
    },
  );
});
