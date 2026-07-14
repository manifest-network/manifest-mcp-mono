import { describe, expect, it } from 'vitest';
import { assertUnicastHost } from './ssrf-resolve.js';

describe('assertUnicastHost', () => {
  it('returns a public unicast IP literal unchanged (no DNS lookup)', async () => {
    await expect(assertUnicastHost('8.8.8.8')).resolves.toBe('8.8.8.8');
  });

  it('blocks loopback IPv4 with a descriptive SSRF error', async () => {
    await expect(assertUnicastHost('127.0.0.1')).rejects.toThrow(
      /SSRF blocked.*loopback/,
    );
  });

  it('blocks loopback IPv6', async () => {
    await expect(assertUnicastHost('::1')).rejects.toThrow(
      /SSRF blocked.*loopback/,
    );
  });

  it('blocks the cloud metadata link-local address', async () => {
    await expect(assertUnicastHost('169.254.169.254')).rejects.toThrow(
      /SSRF blocked.*linkLocal/,
    );
  });

  it('blocks RFC1918 private ranges', async () => {
    await expect(assertUnicastHost('10.0.0.1')).rejects.toThrow(
      /SSRF blocked.*private/,
    );
  });

  it('resolves a hostname and blocks it when it maps to loopback (localhost)', async () => {
    // `localhost` resolves to 127.0.0.1 / ::1 via the kernel resolver — must be blocked.
    await expect(assertUnicastHost('localhost')).rejects.toThrow(
      /SSRF blocked/,
    );
  });

  it('fails closed on an unresolvable / malformed host', async () => {
    await expect(assertUnicastHost('nonexistent.invalid.')).rejects.toThrow(
      /SSRF blocked.*refused to connect/,
    );
  });
});
