import type { FredLeaseRelease } from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import {
  MAX_RELEASE_FIELD_CHARS,
  MAX_RELEASES,
  MAX_RELEASES_CHARS,
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
    ['a non-string supplied directly to the public projector', 42],
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

  it('never forwards a provider-supplied manifest_bytes', () => {
    // A spread cannot overwrite a key its source OMITS, so a raw manifest_bytes left
    // in place would survive whenever `manifest` is invalid — and a non-number would
    // fail the declared z.number() output schema, killing the whole tool call.
    const out = sanitizeReleaseFields(
      release({ manifest: null, manifest_bytes: 'not-a-number' }),
    );
    expect(out).not.toHaveProperty('manifest_bytes');
  });

  it('never forwards a raw last_error the sanitizer chose to drop', () => {
    // sanitizeFailureFields owns last_error and omits it when malformed; leaving the
    // raw key in the spread would defeat that (ENG-638).
    const out = sanitizeReleaseFields(release({ last_error: { nested: 1 } }));
    expect(out).not.toHaveProperty('last_error');
  });

  it('caps an oversized value on ANY forwarded field, not just the manifest', () => {
    // Capping only `manifest` would be trivially bypassable — a provider can put the
    // payload in `image`, or in a key mono does not model at all.
    const out = sanitizeReleaseFields(
      release({ image: 'x'.repeat(100_000), spurious: 'y'.repeat(100_000) }),
    );
    expect(String(out.image).length).toBe(MAX_RELEASE_FIELD_CHARS + 1);
    expect(String(out.spurious).length).toBe(MAX_RELEASE_FIELD_CHARS + 1);
    // Unknown keys are capped, NOT dropped: releases[] is a looseObject so provider
    // drift stays observable, and the e2e wire-golden reads Object.keys(release).
    expect(out).toHaveProperty('spurious');
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

  it('does not re-sort directly supplied releases by version', () => {
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

  it('enforces a total serialized budget when elements carry many keys', () => {
    // The per-field cap bounds each VALUE, but a provider also controls how many KEYS
    // an element has. Each element here is ~2 KB — comfortably under the budget on its
    // own — yet 20 of them are far over it.
    const fat = (version: number) =>
      release({
        version,
        ...Object.fromEntries(
          Array.from({ length: 4 }, (_, k) => [`k${k}`, 'z'.repeat(600)]),
        ),
      });
    const out = projectReleases(
      Array.from({ length: 20 }, (_, i) => fat(i + 1)),
    );

    expect(JSON.stringify(out.releases).length).toBeLessThanOrEqual(
      MAX_RELEASES_CHARS,
    );
    expect(out.releases.length).toBeLessThan(20);
    // Trimmed from the front, so the NEWEST survive.
    expect(out.releases.at(-1)?.version).toBe(20);
    expect(out.truncated).toBe(true);
    expect(out.release_count).toBe(20);
  });

  it('always keeps at least one release, even one that alone exceeds the budget', () => {
    // An empty list would be a worse answer than an over-budget one. This is the
    // documented residual: a single pathological element is bounded only by
    // (key count x MAX_RELEASE_FIELD_CHARS).
    const huge = release(
      Object.fromEntries(
        Array.from({ length: 400 }, (_, k) => [`k${k}`, 'z'.repeat(600)]),
      ),
    );
    const out = projectReleases([huge]);
    expect(out.releases).toHaveLength(1);
    // Still capped per field, so it is bounded — just not by the total budget.
    expect(String(out.releases[0]?.k0).length).toBe(
      MAX_RELEASE_FIELD_CHARS + 1,
    );
  });
});
