import { fromBase64 } from '@cosmjs/encoding';
import { describe, expect, it } from 'vitest';
import {
  createAuthToken,
  createLeaseDataSignMessage,
  createSignMessage,
} from './auth.js';

describe('createSignMessage', () => {
  it('formats tenant:leaseUuid:timestamp', () => {
    expect(createSignMessage('t1', 'uuid1', '2025-01-01T00:00:00Z')).toBe(
      't1:uuid1:2025-01-01T00:00:00Z',
    );
  });
});

describe('createLeaseDataSignMessage', () => {
  it('formats with manifest lease data prefix', () => {
    expect(
      createLeaseDataSignMessage('uuid1', 'abc123', '2025-01-01T00:00:00Z'),
    ).toBe('manifest lease data uuid1 abc123 2025-01-01T00:00:00Z');
  });
});

describe('createAuthToken', () => {
  it('creates base64-encoded JSON token without meta_hash_hex', () => {
    const token = createAuthToken(
      'tenant1',
      'lease1',
      '2025-01-01T00:00:00Z',
      'pk1',
      'sig1',
    );
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64(token)));
    expect(decoded.tenant).toBe('tenant1');
    expect(decoded.lease_uuid).toBe('lease1');
    expect(decoded.timestamp).toBe('2025-01-01T00:00:00Z');
    expect(decoded.pub_key).toBe('pk1');
    expect(decoded.signature).toBe('sig1');
    expect(decoded.meta_hash_hex).toBeUndefined();
  });

  it('includes meta_hash_hex when provided', () => {
    const token = createAuthToken('t', 'l', 'ts', 'pk', 'sig', 'deadbeef');
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64(token)));
    expect(decoded.meta_hash_hex).toBe('deadbeef');
  });
});
