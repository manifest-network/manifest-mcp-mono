import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSignMessage, createAuthToken, validateAuthTimestamp } from './auth.js';

describe('createSignMessage', () => {
  it('should format tenant:leaseUuid:timestamp', () => {
    const msg = createSignMessage('manifest1abc', 'uuid-123', '2025-01-01T00:00:00.000Z');
    expect(msg).toBe('manifest1abc:uuid-123:2025-01-01T00:00:00.000Z');
  });
});

describe('createAuthToken', () => {
  it('should produce a base64-encoded JSON payload', () => {
    const token = createAuthToken('tenant1', 'lease1', '2025-01-01T00:00:00Z', 'pubkey1', 'sig1');
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token), c => c.charCodeAt(0))));
    expect(decoded).toEqual({
      tenant: 'tenant1',
      lease_uuid: 'lease1',
      timestamp: '2025-01-01T00:00:00Z',
      pub_key: 'pubkey1',
      signature: 'sig1',
    });
  });

  it('should include meta_hash_hex when provided', () => {
    const token = createAuthToken('t', 'l', 'ts', 'pk', 'sig', 'abc123');
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token), c => c.charCodeAt(0))));
    expect(decoded.meta_hash_hex).toBe('abc123');
  });

  it('should omit meta_hash_hex when not provided', () => {
    const token = createAuthToken('t', 'l', 'ts', 'pk', 'sig');
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token), c => c.charCodeAt(0))));
    expect(decoded.meta_hash_hex).toBeUndefined();
  });
});

describe('validateAuthTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should accept a timestamp within the validity window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:30.000Z'));
    expect(validateAuthTimestamp('2025-06-01T12:00:00.000Z')).toBe(true);
  });

  it('should reject an expired timestamp (>60s old)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:02:00.000Z'));
    expect(validateAuthTimestamp('2025-06-01T12:00:00.000Z')).toBe(false);
  });

  it('should reject a timestamp too far in the future (>10s)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00.000Z'));
    expect(validateAuthTimestamp('2025-06-01T12:00:15.000Z')).toBe(false);
  });

  it('should accept a timestamp slightly in the future (<10s)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00.000Z'));
    expect(validateAuthTimestamp('2025-06-01T12:00:05.000Z')).toBe(true);
  });

  it('should reject an invalid date string', () => {
    expect(validateAuthTimestamp('not-a-date')).toBe(false);
  });
});
