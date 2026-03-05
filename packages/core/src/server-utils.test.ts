import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  SENSITIVE_FIELDS,
  bigIntReplacer,
  sanitizeForLogging,
  withErrorHandling,
  jsonResponse,
  createMnemonicServer,
  type ManifestMCPServerOptions,
} from './server-utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

/** Extract the text string from the first content item of a CallToolResult */
function textOf(result: CallToolResult): string {
  const item = result.content[0];
  if (item.type !== 'text') throw new Error(`Expected text content, got ${item.type}`);
  return item.text;
}

describe('bigIntReplacer', () => {
  it('converts BigInt to string', () => {
    expect(bigIntReplacer('k', BigInt('123456789'))).toBe('123456789');
  });

  it('passes through non-BigInt values', () => {
    expect(bigIntReplacer('k', 42)).toBe(42);
    expect(bigIntReplacer('k', 'hello')).toBe('hello');
    expect(bigIntReplacer('k', null)).toBeNull();
    expect(bigIntReplacer('k', true)).toBe(true);
  });
});

describe('sanitizeForLogging', () => {
  it('returns null/undefined as-is', () => {
    expect(sanitizeForLogging(null)).toBeNull();
    expect(sanitizeForLogging(undefined)).toBeUndefined();
  });

  it('redacts all sensitive field names', () => {
    const input: Record<string, string> = {};
    for (const field of SENSITIVE_FIELDS) {
      input[field] = 'secret-value';
    }
    input['safe'] = 'visible';

    const result = sanitizeForLogging(input) as Record<string, string>;
    for (const field of SENSITIVE_FIELDS) {
      expect(result[field]).toBe('[REDACTED]');
    }
    expect(result['safe']).toBe('visible');
  });

  it('redacts generic key and token fields', () => {
    const result = sanitizeForLogging({
      key: 'supersecret',
      token: 'abc123',
      safe: 'visible',
    }) as Record<string, string>;
    expect(result['key']).toBe('[REDACTED]');
    expect(result['token']).toBe('[REDACTED]');
    expect(result['safe']).toBe('visible');
  });

  it('redacts sensitive fields case-insensitively', () => {
    const result = sanitizeForLogging({ Password: 'secret' }) as Record<string, string>;
    expect(result['Password']).toBe('[REDACTED]');
  });

  it('redacts 12-word strings as possible mnemonic', () => {
    const words = 'one two three four five six seven eight nine ten eleven twelve';
    expect(sanitizeForLogging(words)).toBe('[REDACTED - possible mnemonic]');
  });

  it('redacts 24-word strings as possible mnemonic', () => {
    const words = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');
    expect(sanitizeForLogging(words)).toBe('[REDACTED - possible mnemonic]');
  });

  it('does not redact strings with other word counts', () => {
    expect(sanitizeForLogging('hello world')).toBe('hello world');
    expect(sanitizeForLogging('one two three')).toBe('one two three');
  });

  it('recursively sanitizes arrays', () => {
    const result = sanitizeForLogging([{ password: 'x' }]) as Array<Record<string, string>>;
    expect(result[0].password).toBe('[REDACTED]');
  });

  it('recursively sanitizes nested objects', () => {
    const result = sanitizeForLogging({ nested: { mnemonic: 'x' } }) as Record<string, Record<string, string>>;
    expect(result.nested.mnemonic).toBe('[REDACTED]');
  });

  it('stops at max depth', () => {
    expect(sanitizeForLogging({ a: 1 }, 11)).toBe('[max depth exceeded]');
  });

  it('passes through numbers and booleans', () => {
    expect(sanitizeForLogging(42)).toBe(42);
    expect(sanitizeForLogging(true)).toBe(true);
  });
});

describe('jsonResponse', () => {
  it('returns CallToolResult with JSON text', () => {
    const result = jsonResponse({ foo: 'bar' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(textOf(result))).toEqual({ foo: 'bar' });
  });

  it('uses custom replacer when provided', () => {
    const result = jsonResponse({ val: BigInt(99) }, bigIntReplacer);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.val).toBe('99');
  });

  it('works without replacer', () => {
    const result = jsonResponse({ a: 1 });
    expect(JSON.parse(textOf(result))).toEqual({ a: 1 });
  });
});

// Callback type for testing tools that accept (args, extra)
type TestToolCb = (_args: Record<string, unknown>, _extra: unknown) => Promise<CallToolResult>;

describe('withErrorHandling', () => {
  it('passes through successful results', async () => {
    const handler = withErrorHandling<TestToolCb>('test', async () => jsonResponse({ ok: true }));
    const result = await handler({}, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ ok: true });
  });

  it('catches ManifestMCPError and returns structured response', async () => {
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'broken', { extra: 'info' });
    });
    const result = await handler({}, {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.code).toBe('QUERY_FAILED');
    expect(parsed.message).toBe('broken');
    expect(parsed.details).toEqual({ extra: 'info' });
  });

  it('catches generic Error and returns message', async () => {
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw new Error('generic');
    });
    const result = await handler({}, {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.message).toBe('generic');
    expect(parsed.code).toBeUndefined();
  });

  it('catches non-Error thrown values', async () => {
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw 'string-error';
    });
    const result = await handler({}, {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.message).toBe('string-error');
  });

  it('handles tools with no args (single callback arg)', async () => {
    const fn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const handler = withErrorHandling('test', fn);
    const extra = { server: {} };
    await handler(extra);
    expect(fn).toHaveBeenCalledWith(extra);
  });

  it('handles tools with args (two callback args)', async () => {
    const fn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const handler = withErrorHandling('test', fn);
    const args = { module: 'bank' };
    const extra = { server: {} };
    await handler(args, extra);
    expect(fn).toHaveBeenCalledWith(args, extra);
  });

  it('redacts sensitive fields in error input', async () => {
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw new Error('fail');
    });
    const result = await handler({ password: 'secret123' }, {});
    const parsed = JSON.parse(textOf(result));
    expect(parsed.input.password).toBe('[REDACTED]');
  });

  it('falls back to minimal JSON and logs serialization failure when stringify fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Create a details object with a toJSON that throws — sanitizeForLogging
    // copies plain properties so it won't trigger toJSON, but JSON.stringify will.
    const details = { info: 'value', toJSON() { throw new Error('toJSON exploded'); } };
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'broken', details);
    });
    const result = await handler({}, {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.error).toBe(true);
    expect(parsed.tool).toBe('test');
    expect(parsed.message).toBe('broken');
    const calls = spy.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('[test] Failed to serialize error response:'))).toBe(true);
    spy.mockRestore();
  });

  it('logs ManifestMCPError message to stderr', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withErrorHandling<TestToolCb>('my_tool', async () => {
      throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'tx broke');
    });
    await handler({}, {});
    expect(spy).toHaveBeenCalledWith('[my_tool] Tool error [TX_FAILED]: tx broke');
    spy.mockRestore();
  });

  it('logs full error object for non-ManifestMCPError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new TypeError('cannot read property of null');
    const handler = withErrorHandling<TestToolCb>('my_tool', async () => {
      throw err;
    });
    await handler({}, {});
    expect(spy).toHaveBeenCalledWith('[my_tool] Tool error [UNKNOWN]:', err);
    spy.mockRestore();
  });
});

describe('createMnemonicServer', () => {
  it('validates config, creates wallet, connects, and returns server instance', async () => {
    class FakeServer {
      opts: ManifestMCPServerOptions;
      constructor(opts: ManifestMCPServerOptions) {
        this.opts = opts;
      }
    }

    const server = await createMnemonicServer(
      {
        chainId: 'test-chain',
        rpcUrl: 'https://rpc.example.com',
        gasPrice: '1.0umfx',
        mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      FakeServer as unknown as new (opts: ManifestMCPServerOptions) => FakeServer,
    );

    expect(server).toBeInstanceOf(FakeServer);
    // Config should be validated — addressPrefix gets its default
    expect(server.opts.config.addressPrefix).toBe('manifest');
    // Wallet should be connected and usable
    const address = await server.opts.walletProvider.getAddress();
    expect(address).toMatch(/^manifest1/);
  });

  it('rejects invalid config', async () => {
    class FakeServer {
      constructor(_opts: ManifestMCPServerOptions) {}
    }

    await expect(
      createMnemonicServer(
        {
          chainId: '',
          rpcUrl: 'https://rpc.example.com',
          gasPrice: '1.0umfx',
          mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        FakeServer as unknown as new (opts: ManifestMCPServerOptions) => FakeServer,
      ),
    ).rejects.toThrow();
  });

  it('rejects invalid mnemonic', async () => {
    class FakeServer {
      constructor(_opts: ManifestMCPServerOptions) {}
    }

    await expect(
      createMnemonicServer(
        {
          chainId: 'test-chain',
          rpcUrl: 'https://rpc.example.com',
          gasPrice: '1.0umfx',
          mnemonic: 'invalid mnemonic words',
        },
        FakeServer as unknown as new (opts: ManifestMCPServerOptions) => FakeServer,
      ),
    ).rejects.toThrow();
  });
});
