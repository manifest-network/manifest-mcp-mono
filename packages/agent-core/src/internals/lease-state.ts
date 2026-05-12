import type { LeaseStateName } from '../types.js';

/**
 * Canonical chain lease-state enum table + decode helpers, used by
 * `classify-deploy-response.ts` and (later) `deploy-app.ts` /
 * `close-lease.ts` / `troubleshoot.ts` to translate integer state codes
 * the chain emits into the typed `LeaseStateName` literal union.
 *
 * **Deliberate fix-up of CJS-vs-chain mismatch.** The plugin source at
 * `manifest-agent-plugin/scripts/_lease-state.cjs` encodes a pre-v2.1.0
 * chain enum (INSUFFICIENT_FUNDS at 3, CLOSED at 4, no entry for 5). The
 * TS port aligns with the current `@manifest-network/manifestjs@2.4.1`
 * `LeaseState` proto (see
 * `node_modules/@manifest-network/manifestjs/dist/codegen/liftedinit/billing/v1/types.d.ts`):
 *
 * ```
 * 0 → LEASE_STATE_UNSPECIFIED
 * 1 → LEASE_STATE_PENDING   — lease awaiting provider acknowledgement; credit locked, billing not started
 * 2 → LEASE_STATE_ACTIVE    — provider acknowledged, resources provisioned, billing accruing
 * 3 → LEASE_STATE_CLOSED    — lease closed normally; final settlement occurred (CJS says INSUFFICIENT_FUNDS here — stale)
 * 4 → LEASE_STATE_REJECTED  — provider rejected the lease; credit returned to tenant (CJS says CLOSED here — stale)
 * 5 → LEASE_STATE_EXPIRED   — lease expired while in PENDING (provider did not acknowledge within the timeout); credit returned. Pre-active terminal state, NOT a post-active expiry (CJS has no entry)
 * ```
 *
 * The proto's `UNRECOGNIZED = -1` enum convenience is NOT included in the
 * STATES map — that value is a TS-enum sentinel for "unknown decode," never
 * a chain emit.
 *
 * Parent-approved divergence (ENG-129). Strict 1:1 with the CJS would
 * mis-decode every lease the chain marks CLOSED, REJECTED, or EXPIRED on
 * v2.1.0+, breaking `DeployResult.leaseState`, `CloseLeaseResult.finalState`,
 * and the verify-recover `lease_terminal` branch at runtime. Plugin-side
 * `_lease-state.cjs` fix tracked as ENG-158.
 *
 * `LEASE_STATE_INSUFFICIENT_FUNDS` is retained as an unreachable variant in
 * the frozen `LeaseStateName` union and in `TERMINAL_STATES` for forward-
 * compat — the chain doesn't emit it under v2.1.0, but the public type
 * permits it and the no-op set entry guards against a future chain
 * regression that re-emits it (defense-in-depth).
 */

const STATES = {
  0: 'LEASE_STATE_UNSPECIFIED',
  1: 'LEASE_STATE_PENDING',
  2: 'LEASE_STATE_ACTIVE',
  3: 'LEASE_STATE_CLOSED',
  4: 'LEASE_STATE_REJECTED',
  5: 'LEASE_STATE_EXPIRED',
} as const satisfies Record<number, LeaseStateName>;

export const TERMINAL_STATES: ReadonlySet<LeaseStateName> =
  new Set<LeaseStateName>([
    'LEASE_STATE_CLOSED',
    'LEASE_STATE_REJECTED',
    'LEASE_STATE_EXPIRED',
    // Retained as defense-in-depth: unreachable from decode() on the
    // current chain (v2.1.0 proto drops INSUFFICIENT_FUNDS), but still a
    // legal LeaseStateName variant. If a future chain regression re-emits
    // it, terminal-state checks downstream still classify correctly without
    // a coordinated update across deploy-app / close-lease / troubleshoot.
    'LEASE_STATE_INSUFFICIENT_FUNDS',
  ]);

/**
 * Decode an integer-or-string lease state into the canonical
 * `LEASE_STATE_*` name. Returns `undefined` for unrecognized input so
 * callers can distinguish "no info" from a known state. Callers that
 * need a display sentinel may widen the return type via `|| 'UNKNOWN'`
 * (or similar) for logging/UI purposes only — `'UNKNOWN'` is NOT a
 * `LeaseStateName` variant, so the widening explicitly opts out of the
 * type narrowing the union provides.
 *
 * Accepts either:
 *   - a numeric (or numeric-coercible string) integer matching a STATES key,
 *   - a string that already starts with `LEASE_STATE_` (passthrough), in
 *     which case the value is returned verbatim — the chain's JSON form
 *     emits the name directly via `leaseStateToJSON`, so this branch
 *     handles both the codec.toJSON() shape and raw integer emit paths.
 *
 * Unrecognized strings (no `LEASE_STATE_` prefix) and out-of-range integers
 * return `undefined`. The passthrough does not validate the suffix against
 * `LeaseStateName` because the chain proto is the source of truth — if a
 * future enum variant appears, it'll flow through; if a malformed string
 * appears, the caller's typed handling catches it.
 */
export function decode(
  state: number | string | undefined,
): LeaseStateName | undefined {
  if (typeof state === 'string' && state.startsWith('LEASE_STATE_')) {
    return state as LeaseStateName;
  }
  const n = Number(state);
  if (Number.isInteger(n) && n in STATES) {
    return STATES[n as keyof typeof STATES];
  }
  return undefined;
}

/** True iff `name` is in the `TERMINAL_STATES` set. Accepts any string for caller convenience. */
export function isTerminal(name: string | undefined): boolean {
  if (typeof name !== 'string') return false;
  return TERMINAL_STATES.has(name as LeaseStateName);
}
