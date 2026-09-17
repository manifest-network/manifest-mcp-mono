import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';
import {
  MAX_TOOL_ERROR_MESSAGE_CHARS,
  MAX_TOOL_ERROR_RESPONSE_CHARS,
  withErrorHandling,
} from './server-utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

function unreadableProperty(
  error: Error,
  property: string,
  thrown: unknown = new Error(`GETTER ${'x'.repeat(20_000)}\u001b\u0007`),
): Error {
  return Object.defineProperty(error, property, {
    get() {
      throw thrown;
    },
  });
}

function sdkError(): ManifestMCPError {
  return new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    'query failed',
  );
}

describe('retried failures at the MCP boundary', () => {
  it.each([
    {
      name: 'message getter',
      create: () => unreadableProperty(new Error('failed'), 'message'),
      message: 'Error message unavailable',
    },
    {
      name: 'revoked proxy',
      create: revokedProxy,
      message: 'Error message unavailable',
    },
    {
      name: 'prototype trap',
      create: () =>
        new Proxy(new Error('failed'), {
          getPrototypeOf() {
            throw revokedProxy();
          },
        }),
      message: 'Error message unavailable',
    },
    {
      name: 'SDK code getter',
      create: () => unreadableProperty(sdkError(), 'code'),
      message: 'query failed',
    },
    {
      name: 'SDK code coercion',
      create: () =>
        Object.defineProperty(sdkError(), 'code', {
          value: {
            [Symbol.toPrimitive]() {
              throw revokedProxy();
            },
          },
        }),
      message: 'query failed',
    },
    {
      name: 'SDK details getter throwing a revoked proxy',
      create: () => unreadableProperty(sdkError(), 'details', revokedProxy()),
      message: 'query failed',
      code: 'QUERY_FAILED',
    },
    {
      name: 'message getter throwing a revoked proxy',
      create: () =>
        unreadableProperty(new Error('failed'), 'message', revokedProxy()),
      message: 'Error message unavailable',
    },
    {
      name: 'stack getter throwing a revoked proxy',
      create: () =>
        unreadableProperty(new Error('failed'), 'stack', revokedProxy()),
      message: 'failed',
    },
    {
      name: 'string coercion throwing a revoked proxy',
      create: () => ({
        [Symbol.toPrimitive]() {
          throw revokedProxy();
        },
      }),
      message: 'Error message unavailable',
    },
  ])('returns a bounded JSON envelope for $name', async (testCase) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = new McpServer({ name: 'retry-test', version: '1.0.0' });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const operation = vi.fn(async () => {
      throw testCase.create();
    });
    const onRetry = vi.fn();
    server.registerTool(
      'probe',
      { description: 'Exercise retry rejection handling.' },
      withErrorHandling('probe', async () =>
        withRetry(operation, {
          config: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
          onRetry,
        }),
      ),
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'probe' });
      expect(result.isError).toBe(true);
      const content = result.content as { type: string; text: string }[];
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('text');
      const text = content[0].text;
      const parsed = JSON.parse(text);
      expect(parsed).toMatchObject({
        error: true,
        tool: 'probe',
        message: testCase.message,
      });
      expect(parsed.code).toBe(testCase.code);
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_ERROR_RESPONSE_CHARS);
      expect(text).not.toContain('GETTER');
      expect(parsed.message).not.toContain('\u001b');
      expect(parsed.message).not.toContain('\u0007');
      expect(log).toHaveBeenCalledWith(
        '[ERROR]',
        expect.stringContaining('[probe] Tool error ['),
      );
      expect(log.mock.calls.flat().join('\n')).not.toContain('GETTER');
      expect(operation).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      log.mockRestore();
    }
  });

  it('keeps readable retry failures sanitized and bounded', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withErrorHandling<() => Promise<CallToolResult>>(
      'probe',
      async () =>
        withRetry(async () => {
          throw new Error(`\u001b[31mfailed ${'x'.repeat(20_000)}\u0007`);
        }),
    );
    try {
      const result = await handler();
      const text = (result.content[0] as { text: string }).text;
      const parsed = JSON.parse(text);
      expect(parsed).toMatchObject({
        error: true,
        tool: 'probe',
        truncated: true,
      });
      expect(parsed.message).toHaveLength(MAX_TOOL_ERROR_MESSAGE_CHARS + 1);
      expect(parsed.message).not.toContain('\u001b');
      expect(parsed.message).not.toContain('\u0007');
      expect(text.length).toBeLessThanOrEqual(MAX_TOOL_ERROR_RESPONSE_CHARS);
    } finally {
      log.mockRestore();
    }
  });

  it('reads the SDK code once when constructing and logging an envelope', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = vi
      .fn()
      .mockReturnValueOnce(ManifestMCPErrorCode.QUERY_FAILED)
      .mockImplementation(() => {
        throw revokedProxy();
      });
    const error = Object.defineProperty(sdkError(), 'code', { get: code });
    const handler = withErrorHandling<() => Promise<CallToolResult>>(
      'probe',
      async () => {
        throw error;
      },
    );
    try {
      const result = await handler();
      const parsed = JSON.parse((result.content[0] as { text: string }).text);
      expect(parsed).toMatchObject({
        code: 'QUERY_FAILED',
        message: 'query failed',
      });
      expect(code).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    {
      name: 'readable Error',
      create: () => new Error('details unavailable'),
      reason: 'details unavailable',
    },
    {
      name: 'readable string',
      create: () => 'details unavailable',
      reason: 'details unavailable',
    },
    {
      name: 'mnemonic',
      create: () => new Error(Array(12).fill('abandon').join(' ')),
      reason: '[REDACTED - possible mnemonic]',
    },
    {
      name: 'revoked proxy',
      create: revokedProxy,
      reason: 'Error message unavailable',
    },
    {
      name: 'getter throwing a revoked proxy',
      create: () =>
        unreadableProperty(new Error('secondary'), 'message', revokedProxy()),
      reason: 'Error message unavailable',
    },
  ])(
    'safely logs the serialization fallback reason for a $name',
    async ({ create, reason }) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const original = unreadableProperty(sdkError(), 'details', create());
      const handler = withErrorHandling<() => Promise<CallToolResult>>(
        'probe',
        async () => {
          throw original;
        },
      );
      try {
        const result = await handler();
        const text = (result.content[0] as { text: string }).text;
        expect(JSON.parse(text)).toStrictEqual({
          error: true,
          tool: 'probe',
          code: 'QUERY_FAILED',
          message: 'query failed',
          truncated: true,
        });
        expect(log).toHaveBeenCalledWith(
          '[ERROR]',
          `[probe] Failed to serialize error response: ${reason}`,
        );
        expect(text.length).toBeLessThanOrEqual(MAX_TOOL_ERROR_RESPONSE_CHARS);
      } finally {
        log.mockRestore();
      }
    },
  );
});
