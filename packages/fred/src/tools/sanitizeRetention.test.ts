import { describe, expect, it } from 'vitest';
import { sanitizeRetentionFields } from './sanitizeRetention.js';

// RIGHT-TO-LEFT OVERRIDE (U+202E) — a \p{Cf} char sanitizeForDisplay strips.
// Built from the code point so no raw bidi glyph lives in the source.
const BIDI = String.fromCharCode(0x202e);

describe('sanitizeRetentionFields', () => {
  it('strips control/bidi chars from restore_hint and items[].sku', () => {
    const out = sanitizeRetentionFields({
      retained_until: '2026-08-01T00:00:00Z',
      restore_hint: `hi${BIDI}there`,
      items: [{ sku: 'a\nb', quantity: 1, service_name: 'web' }],
    });
    // sanitizeForDisplay REPLACES control/format chars with a space, then collapses.
    expect(out.restore_hint).toBe('hi there');
    expect(out.items?.[0]?.sku).toBe('a b');
    expect(out.items?.[0]?.quantity).toBe(1);
    expect(out.items?.[0]?.service_name).toBe('web');
  });

  it('passes retained_until through unchanged (validated, not stripped)', () => {
    const out = sanitizeRetentionFields({
      retained_until: '2026-08-01T00:00:00Z',
    });
    expect(out.retained_until).toBe('2026-08-01T00:00:00Z');
  });

  it('omits partition (owner-only; not in the AI-facing projection)', () => {
    const out = sanitizeRetentionFields({
      restore_hint: 'x',
      // partition is not a declared input param — assert it never appears on output
    } as Parameters<typeof sanitizeRetentionFields>[0]);
    expect(out).not.toHaveProperty('partition');
  });

  it('returns only the keys that were present (no undefined padding)', () => {
    expect(sanitizeRetentionFields({})).toEqual({});
  });
});
