import { describe, expect, it } from 'vitest';
import {
  describeFredFailure,
  FRED_FAILURE_REASONS,
  failureDetail,
  isKnownFailureReason,
  sanitizeFailureFields,
} from './failure-reason.js';

// RIGHT-TO-LEFT OVERRIDE (U+202E) — a \p{Cf} char sanitizeForDisplay strips.
// Written as an escape, not a literal glyph, so it survives editing intact.
const RLO = String.fromCharCode(0x202e);

describe('describeFredFailure', () => {
  it('reads the post-ENG-508 reason/message pair', () => {
    expect(
      describeFredFailure({
        reason: 'ImagePullFailed',
        message: 'image pull failed',
      }),
    ).toEqual({
      reason: 'ImagePullFailed',
      message: 'image pull failed',
      legacy: false,
    });
  });

  it('accepts a reason with no message (Fred allows an empty message)', () => {
    expect(describeFredFailure({ reason: 'Unknown' })).toEqual({
      reason: 'Unknown',
      legacy: false,
    });
  });

  it('accepts a message with no reason', () => {
    expect(describeFredFailure({ message: 'something went wrong' })).toEqual({
      message: 'something went wrong',
      legacy: false,
    });
  });

  it('falls back to a pre-ENG-508 last_error (/status, /provision)', () => {
    expect(describeFredFailure({ last_error: 'OOMKilled' })).toEqual({
      message: 'OOMKilled',
      legacy: true,
    });
  });

  it('falls back to a pre-ENG-508 error (/releases)', () => {
    expect(describeFredFailure({ error: 'timeout' })).toEqual({
      message: 'timeout',
      legacy: true,
    });
  });

  it('prefers the curated message when a provider sends BOTH shapes', () => {
    expect(
      describeFredFailure({
        reason: 'ContainerExited',
        message: 'container exited unexpectedly',
        last_error: '/data/fred/volumes/x: exit_code=1; logs:\nboom',
      }),
    ).toEqual({
      reason: 'ContainerExited',
      message: 'container exited unexpectedly',
      legacy: false,
    });
  });

  it('treats an empty message as absent and falls through to the legacy field', () => {
    expect(
      describeFredFailure({ message: '', last_error: 'OOMKilled' }),
    ).toEqual({ message: 'OOMKilled', legacy: true });
  });

  it('returns undefined when there is no failure signal at all', () => {
    expect(describeFredFailure({})).toBeUndefined();
    expect(describeFredFailure({ reason: '', message: '' })).toBeUndefined();
  });

  it('passes an UNRECOGNIZED reason through verbatim (open, add-only set)', () => {
    // Fred: "consumers MUST tolerate an unrecognized value and fall back to the
    // human message." Never drop it, never substitute Unknown, never throw.
    expect(
      describeFredFailure({ reason: 'SomeFutureReason', message: 'why' }),
    ).toEqual({ reason: 'SomeFutureReason', message: 'why', legacy: false });
  });

  it('defensively drops a non-string reason/message from direct callers', () => {
    const hostile = { reason: 12345, message: { evil: true } } as never;
    expect(describeFredFailure(hostile)).toBeUndefined();
  });
});

describe('failureDetail', () => {
  it('joins reason and message', () => {
    expect(
      failureDetail({ reason: 'ImagePullFailed', message: 'manifest unknown' }),
    ).toBe('ImagePullFailed: manifest unknown');
  });

  it('renders a reason with no message without a dangling separator', () => {
    expect(failureDetail({ reason: 'ImagePullFailed' })).toBe(
      'ImagePullFailed',
    );
  });

  it('renders a pre-ENG-508 last_error unchanged (byte-identical fallback)', () => {
    // Pins the back-compat contract for pollLeaseUntilReady's thrown message.
    expect(failureDetail({ last_error: 'OOMKilled' })).toBe('OOMKilled');
  });

  it('returns undefined when there is nothing to say', () => {
    expect(failureDetail({})).toBeUndefined();
  });
});

describe('isKnownFailureReason', () => {
  it('recognizes every reason this client curates', () => {
    for (const reason of FRED_FAILURE_REASONS) {
      expect(isKnownFailureReason(reason), reason).toBe(true);
    }
  });

  it('does not recognize a future Fred reason', () => {
    expect(isKnownFailureReason('SomeFutureReason')).toBe(false);
  });
});

describe('sanitizeFailureFields', () => {
  it('strips control/bidi chars from message', () => {
    const out = sanitizeFailureFields({
      reason: 'ContainerExited',
      message: `pull${RLO}denied`,
    });
    expect(out.message).not.toContain(RLO);
    expect(out.message).toBe('pull denied');
  });

  it('strips control/bidi chars from reason', () => {
    expect(
      sanitizeFailureFields({ reason: `Image${RLO}PullFailed` }).reason,
    ).toBe('Image PullFailed');
  });

  it('caps message at 256 code points (+1 ellipsis)', () => {
    const out = sanitizeFailureFields({ message: 'x'.repeat(300) });
    expect([...(out.message ?? '')]).toHaveLength(257);
  });

  it('keeps an UNRECOGNIZED reason (sanitizing is not validating)', () => {
    expect(sanitizeFailureFields({ reason: 'SomeFutureReason' }).reason).toBe(
      'SomeFutureReason',
    );
  });

  it('OMITS an empty message rather than emitting the (hidden) placeholder', () => {
    // sanitizeForDisplay('') returns '(hidden)'. Fred legitimately sends an
    // empty message, so emitting it would report a redaction that never happened.
    const out = sanitizeFailureFields({ reason: 'Unknown', message: '' });
    expect(out).not.toHaveProperty('message');
    expect(out.reason).toBe('Unknown');
  });

  it('surfaces a legacy last_error on the canonical message key AND echoes it', () => {
    expect(sanitizeFailureFields({ last_error: 'OOMKilled' })).toEqual({
      message: 'OOMKilled',
      last_error: 'OOMKilled',
    });
  });

  it('echoes a legacy /releases error the same way', () => {
    expect(sanitizeFailureFields({ error: 'timeout' })).toEqual({
      message: 'timeout',
      error: 'timeout',
    });
  });

  it('returns ONLY the keys present — the spread-overwrite invariant', () => {
    // Call sites do `{ ...raw, ...sanitizeFailureFields(raw) }`. A key we emit
    // must always overwrite the raw one; a key we never saw must not appear.
    expect(sanitizeFailureFields({})).toEqual({});
    expect(Object.keys(sanitizeFailureFields({}))).toHaveLength(0);
  });
});
