import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import {
  bigIntReplacer,
  createMnemonicServer,
  isSensitiveKey,
  jsonResponse,
  MAX_TOOL_ERROR_MESSAGE_CHARS,
  type ManifestMCPServerOptions,
  SENSITIVE_FIELDS,
  SENSITIVE_KEY_STEMS,
  sanitizeForDisplay,
  sanitizeForLogging,
  structuredResponse,
  withErrorHandling,
} from './server-utils.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

describe('sanitizeForDisplay', () => {
  // Every control/format code point is an escape-based constant so the source
  // has NO literal invisible characters (which do not survive editing reliably)
  // and each case is unambiguous. Pipeline: control/format -> space, collapse, trim.
  const ESC = '\x1b'; // C0 escape introducer (ANSI/CSI)
  const LS = '\u2028'; // Zl line separator (missed by an ASCII-only filter)
  const NEL = '\u0085'; // C1 next-line control (missed by [\x00-\x1F])
  const RLO = '\u202e'; // Cf bidi right-to-left override (Trojan Source)
  const ZWSP = '\u200b'; // Cf zero-width space

  it('leaves a legitimate ASCII value unchanged', () => {
    expect(sanitizeForDisplay('docker-micro')).toBe('docker-micro');
  });

  it('strips an embedded newline so a hostile name cannot forge a plan line', () => {
    const out = sanitizeForDisplay('docker-micro\n  Total fee:  0 MFX');
    expect(out).not.toMatch(/[\n\r]/);
    expect(out).toBe('docker-micro Total fee: 0 MFX');
  });

  it('strips CR as well as LF', () => {
    expect(sanitizeForDisplay('a\r\nb')).toBe('a b');
  });

  it('strips ANSI/CSI escape sequences (bare ESC U+001B is C0/Cc)', () => {
    const out = sanitizeForDisplay(`${ESC}[31mtext${ESC}[0m`);
    expect(out).not.toContain(ESC);
    expect(out).toContain('text');
  });

  it('strips the Unicode line separator U+2028', () => {
    expect(sanitizeForDisplay(`a${LS}b`)).toBe('a b');
  });

  it('strips the C1 control NEL U+0085', () => {
    expect(sanitizeForDisplay(`a${NEL}b`)).toBe('a b');
  });

  it('strips a bidi override (Trojan Source, U+202E)', () => {
    const out = sanitizeForDisplay(`admin${RLO}gnp.txt`);
    expect(out).not.toContain(RLO);
  });

  it('strips zero-width pad chars (U+200B)', () => {
    expect(sanitizeForDisplay(`a${ZWSP}${ZWSP}${ZWSP}b`)).toBe('a b');
  });

  it('returns the placeholder when the value is entirely control/format chars', () => {
    expect(sanitizeForDisplay(`${RLO}${ZWSP}\n`, 64, '(hidden)')).toBe(
      '(hidden)',
    );
  });

  it('coerces nullish/non-string input to the placeholder rather than throwing', () => {
    expect(sanitizeForDisplay(undefined)).toBe('(hidden)');
    expect(sanitizeForDisplay(null)).toBe('(hidden)');
    // a non-string primitive coerces via String(...) instead of throwing
    expect(sanitizeForDisplay(42)).toBe('42');
    // a symbol must NOT throw: String() is the safe coercion (SymbolDescriptiveString)
    // — unlike `+`/template-literal coercion. Guards a future refactor that would
    // reintroduce a throw for symbols.
    expect(() => sanitizeForDisplay(Symbol('x'))).not.toThrow();
    expect(sanitizeForDisplay(Symbol('x'))).toBe('Symbol(x)');
  });

  it('length-caps an over-long value without bisecting a surrogate pair', () => {
    const out = sanitizeForDisplay('\u{1F600}'.repeat(50), 8);
    expect(out).not.toContain('�'); // never a lone-surrogate replacement char
    expect([...out].length).toBeLessThanOrEqual(9); // 8 code points + ellipsis
    expect(out.endsWith('…')).toBe(true); // ellipsis appended
  });

  it('treats a non-finite / negative maxLength as no-cap rather than misbehaving', () => {
    const long = 'a'.repeat(100);
    // NaN would slice(0, NaN)=>'…'; -1 would drop the last char; both are wrong.
    expect(sanitizeForDisplay(long, Number.NaN)).toBe(long);
    expect(sanitizeForDisplay(long, -1)).toBe(long);
    expect(sanitizeForDisplay(long, Number.POSITIVE_INFINITY)).toBe(long);
    expect(sanitizeForDisplay(long, 2.5)).toBe(long); // non-integer → no cap
  });
});

/** Extract the text string from the first content item of a CallToolResult */
function textOf(result: CallToolResult): string {
  const item = result.content[0];
  if (item.type !== 'text')
    throw new Error(`Expected text content, got ${item.type}`);
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

describe('isSensitiveKey', () => {
  it.each([
    // ENG-747: the camelCase spellings that leaked before normalization.
    'authToken',
    'bearerToken',
    'accessToken',
    'refreshToken',
    'secretKey',
    'signingKey',
    'privateKey',
    'apiKey',
    // The same name in every separator/casing spelling.
    'auth_token',
    'AUTH_TOKEN',
    'auth-token',
    'AuthToken',
    // Compound password forms (ENG-747 acceptance criteria).
    'DB_PASSWORD',
    'POSTGRES_PASSWORD',
    'walletPassword',
    'passphrase',
    // ENG-271(b) additions.
    'authorization',
    'proxy-authorization',
    'bearer',
    'jwt',
    'session',
    'cookie',
    'credential',
    'credentials',
    'priv_key',
    // Header-shaped and OAuth-shaped compounds.
    'X-Auth-Token',
    'clientSecret',
    // Already covered before this change; must stay covered.
    'mnemonic',
    'password',
    'secret',
    'seed',
    'private_key',
    'api_key',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    // Documented non-goals: too generic to match.
    'key',
    'token',
    'Key',
    'TOKEN',
    // Cosmos domain nouns — the regression surface. `pub_key` is a PUBLIC key.
    'pub_key',
    'pubKey',
    'next_key',
    'nextKey',
    'env_key',
    'gas_token',
    'fee_token',
    'chain_token',
    'token_id',
    'token_symbol',
    // Benign identifiers that merely contain a covered word.
    'keygen',
    'keyfileWallet',
    'seedNode',
    'sessionCount',
    // Ordinary payload fields.
    'denom',
    'lease_uuid',
    'fqdn',
    'message',
    'safe',
  ])('treats %s as NOT sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('holds every SENSITIVE_FIELDS entry in already-normalized form', () => {
    for (const field of SENSITIVE_FIELDS) {
      expect(field).toBe(field.toLowerCase().replace(/[_-]/g, ''));
    }
  });

  it('matches each stem on its own', () => {
    for (const stem of SENSITIVE_KEY_STEMS) {
      expect(isSensitiveKey(stem)).toBe(true);
    }
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
    input.safe = 'visible';

    const result = sanitizeForLogging(input) as Record<string, string>;
    for (const field of SENSITIVE_FIELDS) {
      expect(result[field]).toBe('[REDACTED]');
    }
    expect(result.safe).toBe('visible');
  });

  it('redacts specific key and token variant fields', () => {
    const result = sanitizeForLogging({
      secret_key: 'supersecret',
      signing_key: 'abc123',
      auth_token: 'tok',
      key: 'not-sensitive',
      safe: 'visible',
    }) as Record<string, string>;
    expect(result.secret_key).toBe('[REDACTED]');
    expect(result.signing_key).toBe('[REDACTED]');
    expect(result.auth_token).toBe('[REDACTED]');
    expect(result.key).toBe('not-sensitive');
    expect(result.safe).toBe('visible');
  });

  it('redacts camelCase and compound secret keys (ENG-747)', () => {
    const result = sanitizeForLogging({
      authToken: 'S1',
      bearerToken: 'S2',
      accessToken: 'S3',
      refreshToken: 'S4',
      secretKey: 'S5',
      signingKey: 'S6',
      walletPassword: 'S7',
      environment: { DB_PASSWORD: 'S8', PORT: '8080' },
    }) as Record<string, unknown>;

    expect(result.authToken).toBe('[REDACTED]');
    expect(result.bearerToken).toBe('[REDACTED]');
    expect(result.accessToken).toBe('[REDACTED]');
    expect(result.refreshToken).toBe('[REDACTED]');
    expect(result.secretKey).toBe('[REDACTED]');
    expect(result.signingKey).toBe('[REDACTED]');
    expect(result.walletPassword).toBe('[REDACTED]');
    expect(result.environment).toEqual({
      DB_PASSWORD: '[REDACTED]',
      PORT: '8080',
    });
  });

  it('leaves Cosmos domain nouns intact', () => {
    const result = sanitizeForLogging({
      pub_key: 'A1B2',
      next_key: 'cursor',
      gas_token: 'umfx',
      token_id: '42',
      denom: 'upwr',
    }) as Record<string, string>;

    expect(result.pub_key).toBe('A1B2');
    expect(result.next_key).toBe('cursor');
    expect(result.gas_token).toBe('umfx');
    expect(result.token_id).toBe('42');
    expect(result.denom).toBe('upwr');
  });

  it('keeps __proto__ as data without re-parenting the result', () => {
    // JSON.parse materializes __proto__ as a real own property; a plain
    // `out[key] = value` would route it through Object.prototype's setter,
    // which silently DROPS a string value and re-parents the result object
    // for an object value.
    const input = JSON.parse('{"__proto__":{"polluted":true},"safe":"kept"}');
    const result = sanitizeForLogging(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual(
      {
        polluted: true,
      },
    );
    expect(result.safe).toBe('kept');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('redacts sensitive fields case-insensitively', () => {
    const result = sanitizeForLogging({ Password: 'secret' }) as Record<
      string,
      string
    >;
    expect(result.Password).toBe('[REDACTED]');
  });

  it('redacts 12-word strings as possible mnemonic', () => {
    const words =
      'one two three four five six seven eight nine ten eleven twelve';
    expect(sanitizeForLogging(words)).toBe('[REDACTED - possible mnemonic]');
  });

  it('redacts 24-word strings as possible mnemonic', () => {
    const words =
      'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
      'acid acoustic acquire across act action actor actress actual adapt add addict';
    expect(sanitizeForLogging(words)).toBe('[REDACTED - possible mnemonic]');
  });

  it('redacts 15-word strings as possible mnemonic', () => {
    const words =
      'abandon ability able about above absent absorb abstract absurd abuse access accident acid acoustic acquire';
    expect(sanitizeForLogging(words)).toBe('[REDACTED - possible mnemonic]');
  });

  it('redacts 18-word strings as possible mnemonic', () => {
    const words =
      'abandon ability able about above absent absorb abstract absurd abuse access accident acid acoustic acquire across act action';
    expect(sanitizeForLogging(words)).toBe('[REDACTED - possible mnemonic]');
  });

  it('redacts 21-word strings as possible mnemonic', () => {
    const words =
      'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
      'acid acoustic acquire across act action actor actress actual';
    expect(sanitizeForLogging(words)).toBe('[REDACTED - possible mnemonic]');
  });

  it('does not redact 12-word strings containing non-alpha characters', () => {
    // Error messages or data that happen to be 12 words should not be redacted
    const errorMsg =
      'The transaction failed because the account has insufficient funds for gas';
    expect(sanitizeForLogging(errorMsg)).toBe(errorMsg);
    const numberedWords = Array.from({ length: 12 }, (_, i) => `word${i}`).join(
      ' ',
    );
    expect(sanitizeForLogging(numberedWords)).toBe(numberedWords);
  });

  it('does not redact strings with other word counts', () => {
    expect(sanitizeForLogging('hello world')).toBe('hello world');
    expect(sanitizeForLogging('one two three')).toBe('one two three');
    // 13 words — not a valid BIP-39 length
    const thirteen = Array.from({ length: 13 }, (_, i) => `word${i}`).join(' ');
    expect(sanitizeForLogging(thirteen)).toBe(thirteen);
  });

  it('recursively sanitizes arrays', () => {
    const result = sanitizeForLogging([{ password: 'x' }]) as Array<
      Record<string, string>
    >;
    expect(result[0].password).toBe('[REDACTED]');
  });

  it('recursively sanitizes nested objects', () => {
    const result = sanitizeForLogging({ nested: { mnemonic: 'x' } }) as Record<
      string,
      Record<string, string>
    >;
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

describe('structuredResponse', () => {
  it('returns both structuredContent and text content', () => {
    const result = structuredResponse({ foo: 'bar', n: 1 });
    expect(result.structuredContent).toEqual({ foo: 'bar', n: 1 });
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(textOf(result))).toEqual({ foo: 'bar', n: 1 });
  });

  it('applies the replacer to both structuredContent and the text fallback', () => {
    // structuredContent is sent over the wire and must be JSON-serializable.
    // The replacer is the only thing standing between a BigInt-bearing
    // result and a TypeError on the wire, so the helper must apply it to
    // structuredContent too — not only to the text fallback.
    const result = structuredResponse({ val: BigInt(42) }, bigIntReplacer);
    expect(result.structuredContent).toEqual({ val: '42' });
    expect(JSON.parse(textOf(result))).toEqual({ val: '42' });
  });
});

// Callback type for testing tools that accept async (args, extra)
type TestToolCb = (
  _args: Record<string, unknown>,
  _extra: unknown,
) => Promise<CallToolResult>;

describe('withErrorHandling', () => {
  it('passes through successful results', async () => {
    const handler = withErrorHandling<TestToolCb>('test', async () =>
      jsonResponse({ ok: true }),
    );
    const result = await handler({}, {});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ ok: true });
  });

  it('catches ManifestMCPError and returns structured response', async () => {
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, 'broken', {
        extra: 'info',
      });
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

  // The if/else in withErrorHandling already separates first-party from untrusted, so
  // the cap rides that split rather than being applied to everything (ENG-669).
  describe('response-size bound (ENG-669)', () => {
    it('caps an over-long message mono did not author', async () => {
      const handler = withErrorHandling<TestToolCb>('test', async () => {
        throw new Error('x'.repeat(100_000));
      });
      const parsed = JSON.parse(textOf(await handler({}, {})));
      expect(parsed.message.length).toBe(MAX_TOOL_ERROR_MESSAGE_CHARS + 1);
      expect(parsed.message.endsWith('…')).toBe(true);
    });

    it('leaves a first-party ManifestMCPError recovery message uncapped', async () => {
      // These are curated guidance whose length is a reviewed design choice —
      // truncating them would amputate advice the agent must read.
      const long = `RECOVERY: ${'y'.repeat(3_000)}`;
      const handler = withErrorHandling<TestToolCb>('test', async () => {
        throw new ManifestMCPError(ManifestMCPErrorCode.QUERY_FAILED, long);
      });
      const parsed = JSON.parse(textOf(await handler({}, {})));
      expect(parsed.message).toBe(long);
    });

    it('still logs the full message to stderr after capping the response', async () => {
      // Pins against a naive in-place cap of safeMessage: stderr is not model
      // context, so there is no reason to lose the diagnostic there.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = withErrorHandling<TestToolCb>('test', async () => {
        throw new Error(`${'z'.repeat(100_000)}TAIL`);
      });
      await handler({}, {});
      expect(spy.mock.calls.flat().join('\n')).toContain('TAIL');
      spy.mockRestore();
    });

    it('redacts a mnemonic BEFORE capping, not after', async () => {
      const mnemonic = Array(24).fill('abandon').join(' ');
      const handler = withErrorHandling<TestToolCb>('test', async () => {
        throw new Error(mnemonic);
      });
      const parsed = JSON.parse(textOf(await handler({}, {})));
      expect(parsed.message).toBe('[REDACTED - possible mnemonic]');
    });
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
    const details = {
      info: 'value',
      toJSON() {
        throw new Error('toJSON exploded');
      },
    };
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.QUERY_FAILED,
        'broken',
        details,
      );
    });
    const result = await handler({}, {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.error).toBe(true);
    expect(parsed.tool).toBe('test');
    expect(parsed.message).toBe('broken');
    const calls = spy.mock.calls.map((c) => c.map((a) => String(a)).join(' '));
    expect(
      calls.some((c) =>
        c.includes('[test] Failed to serialize error response:'),
      ),
    ).toBe(true);
    spy.mockRestore();
  });

  it('logs ManifestMCPError message to stderr', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withErrorHandling<TestToolCb>('my_tool', async () => {
      throw new ManifestMCPError(ManifestMCPErrorCode.TX_FAILED, 'tx broke');
    });
    await handler({}, {});
    expect(spy).toHaveBeenCalledWith(
      '[ERROR]',
      '[my_tool] Tool error [TX_FAILED]: tx broke',
    );
    spy.mockRestore();
  });

  it('logs message and stack for non-ManifestMCPError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new TypeError('cannot read property of null');
    const handler = withErrorHandling<TestToolCb>('my_tool', async () => {
      throw err;
    });
    await handler({}, {});
    // logger.error calls console.error('[ERROR]', message)
    const logged = spy.mock.calls[0].map((a) => String(a)).join(' ');
    expect(logged).toContain(
      '[my_tool] Tool error [UNKNOWN]: cannot read property of null',
    );
    expect(logged).toContain('TypeError');
    spy.mockRestore();
  });

  it('sanitizes mnemonic in error message before logging non-ManifestMCPError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mnemonic =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const handler = withErrorHandling<TestToolCb>('my_tool', async () => {
      throw new Error(mnemonic);
    });
    await handler({}, {});
    const logged = spy.mock.calls[0].map((a) => String(a)).join(' ');
    expect(logged).not.toContain('abandon ability');
    expect(logged).toContain('[REDACTED');
    spy.mockRestore();
  });

  it('sanitizes standalone mnemonic error messages before returning to MCP client', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A standalone 12-word mnemonic as the entire error message
    const mnemonic =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw new Error(mnemonic);
    });
    const result = await handler({}, {});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.message).toBe('[REDACTED - possible mnemonic]');
    spy.mockRestore();
  });

  it('sanitizes ManifestMCPError message with standalone mnemonic', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mnemonic =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const handler = withErrorHandling<TestToolCb>('test', async () => {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
        mnemonic,
      );
    });
    const result = await handler({}, {});
    const parsed = JSON.parse(textOf(result));
    expect(parsed.message).toBe('[REDACTED - possible mnemonic]');
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
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      FakeServer as unknown as new (
        opts: ManifestMCPServerOptions,
      ) => FakeServer,
    );

    expect(server).toBeInstanceOf(FakeServer);
    // Config should be validated — addressPrefix gets its default
    expect(server.opts.config.addressPrefix).toBe('manifest');
    // Wallet should be connected and usable
    const address = await server.opts.walletProvider.getAddress();
    expect(address).toMatch(/^manifest1/);
  });

  it('rejects invalid config', async () => {
    class FakeServer {}

    await expect(
      createMnemonicServer(
        {
          chainId: '',
          rpcUrl: 'https://rpc.example.com',
          gasPrice: '1.0umfx',
          mnemonic:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        },
        FakeServer as unknown as new (
          opts: ManifestMCPServerOptions,
        ) => FakeServer,
      ),
    ).rejects.toThrow();
  });

  it('passes gasMultiplier through to validated config', async () => {
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
        gasMultiplier: 2.5,
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      },
      FakeServer as unknown as new (
        opts: ManifestMCPServerOptions,
      ) => FakeServer,
    );

    expect(server.opts.config.gasMultiplier).toBe(2.5);
  });

  it('rejects invalid mnemonic', async () => {
    class FakeServer {}

    await expect(
      createMnemonicServer(
        {
          chainId: 'test-chain',
          rpcUrl: 'https://rpc.example.com',
          gasPrice: '1.0umfx',
          mnemonic: 'invalid mnemonic words',
        },
        FakeServer as unknown as new (
          opts: ManifestMCPServerOptions,
        ) => FakeServer,
      ),
    ).rejects.toThrow();
  });
});
