import {
  isRetryableError,
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

describe('contextual error retry verdicts', () => {
  it.each([
    [
      'native cancellation',
      () => Object.assign(new Error('fetch failed'), { name: 'AbortError' }),
    ],
    [
      'native timeout',
      () => Object.assign(new Error('fetch failed'), { name: 'TimeoutError' }),
    ],
    [
      'permanent status',
      () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'fetch failed',
          { grpcCode: 3 },
        ),
    ],
    [
      'submitted operation',
      () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'fetch failed',
          { sent: true },
        ),
    ],
    [
      'partial operation',
      () =>
        new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'fetch failed',
          { partial: true },
        ),
    ],
    [
      'nested permanent error',
      () =>
        Object.assign(new Error('fetch failed'), {
          cause: new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_CONFIG,
            'invalid configuration',
          ),
        }),
    ],
  ] as const)(
    'preserves the %s veto when attribution would discard it',
    (_name, makeError) => {
      const original = makeError();
      expect(isRetryableError(original)).toBe(false);
      const contextual = contextualError(
        original,
        ManifestMCPErrorCode.SIMULATION_FAILED,
        'Failed to estimate: ',
      );
      expect(contextual.message).toBe('Failed to estimate: fetch failed');
      expect(isRetryableError(contextual)).toBe(false);
      expect(
        Object.getOwnPropertyDescriptor(contextual, 'cause'),
      ).toMatchObject({ value: original, enumerable: false });
      expect(contextual.details).toBeUndefined();
    },
  );

  it.each([
    ['readable transient message', new Error('fetch failed'), true],
    [
      'transient status only',
      new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'estimate unavailable',
        { httpStatus: 503 },
      ),
      false,
    ],
    [
      'nested transient only',
      Object.assign(new Error('estimate unavailable'), {
        cause: new Error('fetch failed'),
      }),
      false,
    ],
    [
      'ordinary permanent code',
      new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, 'fetch failed'),
      false,
    ],
    ['ordinary diagnostic', new Error('estimate unavailable'), false],
  ] as const)(
    'keeps historical cause omission for %s',
    (_name, original, retryable) => {
      const contextual = contextualError(
        original,
        ManifestMCPErrorCode.SIMULATION_FAILED,
        'Failed to estimate: ',
      );
      expect(isRetryableError(contextual)).toBe(retryable);
      expect(
        Object.getOwnPropertyDescriptor(contextual, 'cause'),
      ).toBeUndefined();
      expect(contextual.details).toBeUndefined();
    },
  );
});
