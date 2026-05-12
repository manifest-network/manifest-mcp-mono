import { describe, expect, it } from 'vitest';
import {
  PROTOTYPE_POLLUTION_KEYS,
  SECRET_KEY_DENYLIST,
  stripDenylist,
} from './secret-denylist.js';

describe('SECRET_KEY_DENYLIST', () => {
  it('matches the byte-exact regex from _journal.cjs', () => {
    // qa-engineer's parity check: the source must equal _journal.cjs:127.
    expect(SECRET_KEY_DENYLIST.source).toBe(
      '(mnemonic|password|private[_-]?key|secret[_-]?key|api[_-]?key|auth[_-]?token|bearer[_-]?token)',
    );
    expect(SECRET_KEY_DENYLIST.flags).toBe('i');
  });

  it.each([
    'mnemonic',
    'MNEMONIC',
    'password',
    'wallet_password',
    'private_key',
    'private-key',
    'privatekey',
    'PrivateKey',
    'secret_key',
    'secretkey',
    'api_key',
    'apikey',
    'API_KEY',
    'auth_token',
    'authtoken',
    'bearer_token',
    'bearertoken',
  ])('matches sensitive key %s', (key) => {
    expect(SECRET_KEY_DENYLIST.test(key)).toBe(true);
  });

  it.each([
    'token',
    'secret',
    'gas_token',
    'fee_token',
    'token_id',
    'token_symbol',
    'denom',
    'lease_uuid',
    'fqdn',
    'message',
  ])('does NOT match benign blockchain key %s', (key) => {
    expect(SECRET_KEY_DENYLIST.test(key)).toBe(false);
  });
});

describe('PROTOTYPE_POLLUTION_KEYS', () => {
  it('contains the three constructor-related keys', () => {
    expect(PROTOTYPE_POLLUTION_KEYS.has('__proto__')).toBe(true);
    expect(PROTOTYPE_POLLUTION_KEYS.has('constructor')).toBe(true);
    expect(PROTOTYPE_POLLUTION_KEYS.has('prototype')).toBe(true);
  });

  it('does not contain unrelated keys', () => {
    expect(PROTOTYPE_POLLUTION_KEYS.has('outcome')).toBe(false);
    expect(PROTOTYPE_POLLUTION_KEYS.has('proto')).toBe(false);
  });
});

describe('stripDenylist', () => {
  it('returns primitives unchanged', () => {
    expect(stripDenylist('hello')).toBe('hello');
    expect(stripDenylist(42)).toBe(42);
    expect(stripDenylist(true)).toBe(true);
    expect(stripDenylist(false)).toBe(false);
    expect(stripDenylist(null)).toBe(null);
    expect(stripDenylist(undefined)).toBe(undefined);
  });

  it('strips top-level denylisted keys, keeps non-matching', () => {
    const out = stripDenylist({
      outcome: 'ok',
      api_key: 'leaked',
      password: 'leaked',
      actual: 'kept',
    });
    expect(out).toEqual({ outcome: 'ok', actual: 'kept' });
  });

  it('strips nested denylisted keys at every depth (recursive walk)', () => {
    const out = stripDenylist({
      outcome: 'ok',
      details: {
        api_key: 'nested-leak-1',
        deeper: { password: 'nested-leak-2', safe_field: 'kept' },
      },
      auth_token: 'top-level-strip',
      list: [{ private_key: 'in-array-leak', other: 'kept' }, 'string-element'],
      actual: 'kept-top-level',
    });
    expect(out).toEqual({
      outcome: 'ok',
      details: {
        deeper: { safe_field: 'kept' },
      },
      list: [{ other: 'kept' }, 'string-element'],
      actual: 'kept-top-level',
    });
  });

  it('skips prototype-pollution keys at every depth (no prototype mutation)', () => {
    // JSON.parse materializes __proto__ as a regular own property, so a
    // naive `out[k] = v` would re-set the prototype of the local out object.
    // stripDenylist skips the three constructor-related keys explicitly.
    const sourceJson = JSON.stringify({
      outcome: 'ok',
      __proto__: { polluted_top: 'should-not-survive' },
      constructor: { polluted_via_constructor: 'should-not-survive' },
      prototype: { polluted_via_prototype: 'should-not-survive' },
      nested: {
        __proto__: { polluted_nested: 'should-not-survive' },
        safe: 'kept',
      },
      list: [
        {
          __proto__: { polluted_in_array_elem: 'should-not-survive' },
          item_safe: 'kept',
        },
      ],
      actual: 'kept-top-level',
    });
    const out = stripDenylist(JSON.parse(sourceJson));

    expect(out).toEqual({
      outcome: 'ok',
      nested: { safe: 'kept' },
      list: [{ item_safe: 'kept' }],
      actual: 'kept-top-level',
    });

    // The result's prototype is Object.prototype — no mutation.
    expect(Object.getPrototypeOf(out as object)).toBe(Object.prototype);
    // Polluted payload values are not reachable.
    const stringified = JSON.stringify(out);
    expect(stringified).not.toMatch(/polluted_top/);
    expect(stringified).not.toMatch(/polluted_via_constructor/);
    expect(stringified).not.toMatch(/polluted_via_prototype/);
    expect(stringified).not.toMatch(/polluted_nested/);
    expect(stringified).not.toMatch(/polluted_in_array_elem/);
  });

  it('walks arrays element-wise', () => {
    const out = stripDenylist([
      { api_key: 'leaked', kept: 'ok' },
      'literal',
      42,
      [{ password: 'leaked' }, { ok: 'ok' }],
    ]);
    expect(out).toEqual([{ kept: 'ok' }, 'literal', 42, [{}, { ok: 'ok' }]]);
  });

  it('preserves empty objects and arrays', () => {
    expect(stripDenylist({})).toEqual({});
    expect(stripDenylist([])).toEqual([]);
    expect(stripDenylist({ list: [], nested: {} })).toEqual({
      list: [],
      nested: {},
    });
  });
});
