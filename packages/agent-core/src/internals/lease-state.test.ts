import { describe, expect, it } from 'vitest';
import type { LeaseStateName } from '../types.js';
import { decode, isTerminal, TERMINAL_STATES } from './lease-state.js';

describe('decode — chain-aligned (manifestjs 2.4.1 proto)', () => {
  it.each<[number, LeaseStateName]>([
    [0, 'LEASE_STATE_UNSPECIFIED'],
    [1, 'LEASE_STATE_PENDING'],
    [2, 'LEASE_STATE_ACTIVE'],
    [3, 'LEASE_STATE_CLOSED'],
    [4, 'LEASE_STATE_REJECTED'],
    [5, 'LEASE_STATE_EXPIRED'],
  ])('decodes integer %i → %s', (input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  it.each<[string, LeaseStateName]>([
    ['0', 'LEASE_STATE_UNSPECIFIED'],
    ['3', 'LEASE_STATE_CLOSED'],
    ['5', 'LEASE_STATE_EXPIRED'],
  ])('decodes numeric-coercible string "%s" → %s', (input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  it.each([
    'LEASE_STATE_UNSPECIFIED',
    'LEASE_STATE_PENDING',
    'LEASE_STATE_ACTIVE',
    'LEASE_STATE_CLOSED',
    'LEASE_STATE_REJECTED',
    'LEASE_STATE_EXPIRED',
    'LEASE_STATE_INSUFFICIENT_FUNDS', // legacy/unreachable but passes through
    'LEASE_STATE_FUTURE_VARIANT', // forward-compat passthrough
  ])('passes through canonical LEASE_STATE_* string %s', (input) => {
    expect(decode(input)).toBe(input);
  });

  it.each([
    6, 7, 99, -1, -2,
  ])('returns undefined for out-of-range integer %i', (input) => {
    expect(decode(input)).toBeUndefined();
  });

  it.each([
    'unknown',
    'STATE_CLOSED',
    'pending',
    'closed',
  ])('returns undefined for non-canonical string %s', (input) => {
    expect(decode(input)).toBeUndefined();
  });

  it('decodes empty string to UNSPECIFIED (CJS-parity Number("") === 0 coercion)', () => {
    // CJS _lease-state.cjs decode("") path: Number("") === 0; Number.isInteger(0)
    // && 0 in STATES → 'LEASE_STATE_UNSPECIFIED'. Preserved verbatim. The
    // chain never emits "" so this is an academic edge case, but parity matters
    // for any wrapping caller already shielding their own empty-string handling.
    expect(decode('')).toBe('LEASE_STATE_UNSPECIFIED');
  });

  it('returns undefined for undefined / NaN inputs', () => {
    expect(decode(undefined)).toBeUndefined();
    expect(decode(Number.NaN)).toBeUndefined();
  });
});

describe('TERMINAL_STATES', () => {
  it('includes CLOSED, REJECTED, EXPIRED (chain-emitted terminals)', () => {
    expect(TERMINAL_STATES.has('LEASE_STATE_CLOSED')).toBe(true);
    expect(TERMINAL_STATES.has('LEASE_STATE_REJECTED')).toBe(true);
    expect(TERMINAL_STATES.has('LEASE_STATE_EXPIRED')).toBe(true);
  });

  it('includes INSUFFICIENT_FUNDS as defense-in-depth no-op', () => {
    // Unreachable from decode() on the current chain but kept in the set
    // so a future chain regression re-emitting it still classifies as terminal.
    expect(TERMINAL_STATES.has('LEASE_STATE_INSUFFICIENT_FUNDS')).toBe(true);
  });

  it('does NOT include non-terminal states', () => {
    expect(TERMINAL_STATES.has('LEASE_STATE_UNSPECIFIED')).toBe(false);
    expect(TERMINAL_STATES.has('LEASE_STATE_PENDING')).toBe(false);
    expect(TERMINAL_STATES.has('LEASE_STATE_ACTIVE')).toBe(false);
  });
});

describe('isTerminal', () => {
  it.each([
    'LEASE_STATE_CLOSED',
    'LEASE_STATE_REJECTED',
    'LEASE_STATE_EXPIRED',
    'LEASE_STATE_INSUFFICIENT_FUNDS',
  ])('returns true for %s', (name) => {
    expect(isTerminal(name)).toBe(true);
  });

  it.each([
    'LEASE_STATE_UNSPECIFIED',
    'LEASE_STATE_PENDING',
    'LEASE_STATE_ACTIVE',
    'unknown',
    '',
  ])('returns false for %s', (name) => {
    expect(isTerminal(name)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTerminal(undefined)).toBe(false);
  });
});
