import type { FredLeaseRelease } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import {
  MAX_RELEASES,
  projectReleases,
  sanitizeReleaseFields,
} from './sanitizeReleases.js';

function release(over: Record<string, unknown> = {}): FredLeaseRelease {
  return {
    version: 1,
    image: 'nginx:1.0',
    status: 'active',
    created_at: '2025-01-01T00:00:00Z',
    ...over,
  } as FredLeaseRelease;
}

describe('sanitizeReleaseFields (ENG-669)', () => {
  it('drops the manifest blob and reports its decoded size instead', () => {
    // btoa('{"image":"nginx"}') — 17 bytes.
    const out = sanitizeReleaseFields(
      release({ manifest: 'eyJpbWFnZSI6Im5naW54In0=' }),
    );
    expect(out).not.toHaveProperty('manifest');
    expect(out.manifest_bytes).toBe(17);
    // Everything else survives untouched.
    expect(out.version).toBe(1);
    expect(out.image).toBe('nginx:1.0');
  });

  it.each([
    ['null (a nil Go []byte)', null],
    ['absent', undefined],
    ['a non-string (provider JSON is type-asserted, never validated)', 42],
    ['empty', ''],
  ])('omits manifest_bytes when the manifest is %s', (_label, manifest) => {
    const out = sanitizeReleaseFields(release({ manifest }));
    expect(out).not.toHaveProperty('manifest');
    expect(out).not.toHaveProperty('manifest_bytes');
  });

  it.each([
    ['not base64 at all', '!!!!'],
    ['a length that is not a multiple of 4', 'abc'],
  ])(
    'omits manifest_bytes rather than guessing when the value is %s',
    (_label, manifest) => {
      expect(sanitizeReleaseFields(release({ manifest }))).not.toHaveProperty(
        'manifest_bytes',
      );
    },
  );

  it('still sanitizes the failure fields through the refactor (ENG-638)', () => {
    // Escaped, not a literal glyph: a raw bidi code point gets mangled in transit.
    const RLO = '\u202E';
    const out = sanitizeReleaseFields(
      release({
        status: 'failed',
        reason: 'UpdateFailed',
        message: `roll${RLO}back`,
      }),
    );
    expect(out.reason).toBe('UpdateFailed');
    expect(String(out.message)).not.toContain(RLO);
  });

  it('drops a malformed reason rather than forwarding it into a z.string() field', () => {
    // The exact shape that would otherwise fail output validation and kill the call.
    const out = sanitizeReleaseFields(release({ reason: 12345 }));
    expect(out).not.toHaveProperty('reason');
  });
});

describe('projectReleases (ENG-669)', () => {
  it('keeps the most recent MAX_RELEASES and reports the true total', () => {
    const all = Array.from({ length: 30 }, (_, i) =>
      release({ version: i + 1 }),
    );
    const out = projectReleases(all);

    expect(out.releases).toHaveLength(MAX_RELEASES);
    // The TAIL: Fred appends, so newest is last.
    expect(out.releases[0]?.version).toBe(11);
    expect(out.releases.at(-1)?.version).toBe(30);
    expect(out.release_count).toBe(30);
    expect(out.truncated).toBe(true);
  });

  it('passes a short history through untruncated', () => {
    const out = projectReleases([
      release({ version: 1 }),
      release({ version: 2 }),
    ]);
    expect(out.releases).toHaveLength(2);
    expect(out.release_count).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('does not re-sort by version, which is type-asserted off the wire', () => {
    const out = projectReleases([
      release({ version: 9 }),
      release({ version: 'not-a-number' }),
      release({ version: 2 }),
    ]);
    expect(out.releases.map((r) => r.version)).toEqual([9, 'not-a-number', 2]);
  });

  it('bounds what a large history costs in model context', () => {
    const all = Array.from({ length: 500 }, (_, i) =>
      release({ version: i + 1, manifest: 'A'.repeat(400_000) }),
    );
    // Both the blob and the count are bounded, so the serialized projection stays
    // small no matter what the provider sends.
    expect(JSON.stringify(projectReleases(all)).length).toBeLessThan(5_000);
  });
});
