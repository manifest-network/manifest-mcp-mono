import { describe, expect, it, vi } from 'vitest';
import type {
  FailureEnvelope,
  RecoveryChoice,
  RecoveryOption,
} from '../types.js';
import {
  type VerificationBranch,
  type VerificationSpec,
  type Verifier,
  verifyAndRecover,
} from './verify-recover.js';

const UUID = '11111111-1111-4111-8111-111111111111';

// --- shared fixtures (TS-port analogues of tests/verify-recover.test.cjs fixture builders) ----

type DomainOutcome = 'match' | 'mismatch' | 'not_found';
interface DomainDiag {
  actual?: string;
  reason?: string;
}

function domainVerifier(result: {
  outcome: DomainOutcome;
  diagnostic: DomainDiag;
}): Verifier<unknown, DomainOutcome, DomainDiag> {
  return async () => result;
}

function domainBranch(
  branchId: VerificationBranch['branchId'],
  tag: string,
  envelopeReason: (d: DomainDiag) => string,
  options: RecoveryOption[] = [],
): VerificationBranch<DomainDiag> {
  return {
    branchId,
    journalActionTags: [tag],
    buildFailureEnvelope: (d) => ({
      outcome: 'partially_succeeded',
      leaseUuid: UUID,
      reason: envelopeReason(d),
    }),
    buildRecoveryOptions: () => options,
  };
}

const STANDARD_OPTIONS: RecoveryOption[] = [
  { id: 'retry_set_domain', label: 'Retry', description: 'Retry set-domain' },
  {
    id: 'salvage_without_domain',
    label: 'Salvage',
    description: 'Continue without domain',
  },
];

// =============================================================================
// Direct ports — CJS test cases that map 1:1 to TS behavior
// =============================================================================

describe('case 1 — success on match outcome → branch_id null, no tags', () => {
  it('returns success result with empty diagnostic surface', async () => {
    const spec: VerificationSpec<unknown, DomainOutcome, DomainDiag> = {
      verifier: domainVerifier({
        outcome: 'match',
        diagnostic: { actual: 'app.example.com' },
      }),
      successValues: ['match'],
      branches: {
        mismatch: domainBranch(
          'domain_verification_mismatch',
          'domain-verification-mismatch',
          (d) => `mismatch: ${d.actual}`,
          STANDARD_OPTIONS,
        ),
      },
    };
    const result = await verifyAndRecover(spec, {});
    expect(result.result).toBe('success');
    expect(result.verifierOutcome).toBe('match');
    expect(result.branchId).toBeNull();
    expect(result.journalActionTags).toEqual([]);
    expect(result.diagnostic).toEqual({ actual: 'app.example.com' });
    expect(result.failure).toBeUndefined();
    expect(result.recoveryChoice).toBeUndefined();
  });
});

describe('case 2 — failure on mismatch → named branch, tag, envelope, onFailure called', () => {
  it('dispatches mismatch branch, onFailure receives envelope + options, returns choice', async () => {
    const onFailure = vi.fn<
      (
        failure: FailureEnvelope,
        options: RecoveryOption[],
      ) => Promise<RecoveryChoice>
    >(async () => ({ id: 'retry_set_domain' }));

    const spec: VerificationSpec<unknown, DomainOutcome, DomainDiag> = {
      verifier: domainVerifier({
        outcome: 'mismatch',
        diagnostic: { actual: 'old.example.com' },
      }),
      successValues: ['match'],
      branches: {
        mismatch: domainBranch(
          'domain_verification_mismatch',
          'domain-verification-mismatch',
          (d) => `Chain shows ${d.actual} instead of new.example.com`,
          STANDARD_OPTIONS,
        ),
      },
    };
    const result = await verifyAndRecover(spec, {}, { onFailure });

    expect(result.result).toBe('failure');
    expect(result.branchId).toBe('domain_verification_mismatch');
    expect(result.journalActionTags).toEqual(['domain-verification-mismatch']);
    expect(result.failure).toEqual({
      outcome: 'partially_succeeded',
      leaseUuid: UUID,
      reason: 'Chain shows old.example.com instead of new.example.com',
    });
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[1]).toEqual(STANDARD_OPTIONS);
    expect(result.recoveryChoice).toEqual({ id: 'retry_set_domain' });
  });
});

describe('case 3 — failure on not_found → named branch', () => {
  it('dispatches not_found branch with its tag', async () => {
    const onFailure = vi.fn(async () => ({ id: 'close_lease' as const }));
    const spec: VerificationSpec<unknown, DomainOutcome, DomainDiag> = {
      verifier: domainVerifier({
        outcome: 'not_found',
        diagnostic: { reason: 'lease UUID not in tenant leases' },
      }),
      successValues: ['match'],
      branches: {
        not_found: {
          branchId: 'unclassified',
          journalActionTags: ['domain-verification-not-found'],
          buildFailureEnvelope: (d) => ({
            outcome: 'failed',
            reason: d.reason ?? 'lease not visible',
          }),
          buildRecoveryOptions: () => [
            { id: 'close_lease', label: 'Close', description: 'Close lease' },
          ],
        },
      },
    };
    const result = await verifyAndRecover(spec, {}, { onFailure });
    expect(result.result).toBe('failure');
    expect(result.journalActionTags).toEqual(['domain-verification-not-found']);
    expect(result.failure?.reason).toMatch(/lease UUID not in tenant leases/);
  });
});

describe('case 4 — close-lease success outcome typed differently (terminal:true)', () => {
  it('treats {terminal:true} as success outcome via a typed boolean union', async () => {
    // The TS port models lease-state verifier outcomes as a string enum
    // ('terminal' vs 'pending') rather than boolean values. This case
    // demonstrates a verifier returning the success-indicating outcome.
    type CloseOutcome = 'terminal' | 'pending';
    interface CloseDiag {
      name: string;
    }
    const spec: VerificationSpec<unknown, CloseOutcome, CloseDiag> = {
      verifier: async () => ({
        outcome: 'terminal',
        diagnostic: { name: 'LEASE_STATE_CLOSED' },
      }),
      successValues: ['terminal'],
      branches: {
        pending: {
          branchId: 'pending_drift',
          journalActionTags: ['close-lease-verify-pending'],
          buildFailureEnvelope: (d) => ({
            outcome: 'failed',
            reason: `close_lease tx accepted but state is still ${d.name}`,
          }),
          buildRecoveryOptions: () => [],
        },
      },
    };
    const result = await verifyAndRecover(spec, {});
    expect(result.result).toBe('success');
    expect(result.diagnostic).toEqual({ name: 'LEASE_STATE_CLOSED' });
  });
});

describe('case 5 — close-lease failure: pending state → pending_drift branch', () => {
  it('dispatches pending_drift branch with surface text bound from diagnostic', async () => {
    type CloseOutcome = 'terminal' | 'pending';
    interface CloseDiag {
      name: string;
    }
    const spec: VerificationSpec<unknown, CloseOutcome, CloseDiag> = {
      verifier: async () => ({
        outcome: 'pending',
        diagnostic: { name: 'LEASE_STATE_PENDING' },
      }),
      successValues: ['terminal'],
      branches: {
        pending: {
          branchId: 'pending_drift',
          journalActionTags: ['close-lease-verify-pending'],
          buildFailureEnvelope: (d) => ({
            outcome: 'failed',
            reason: `close_lease tx accepted but state is still ${d.name}`,
          }),
          buildRecoveryOptions: () => [],
        },
      },
    };
    const result = await verifyAndRecover(spec, {});
    expect(result.result).toBe('failure');
    expect(result.branchId).toBe('pending_drift');
    expect(result.failure?.reason).toBe(
      'close_lease tx accepted but state is still LEASE_STATE_PENDING',
    );
  });
});

describe('case 9 — catch-all `__other__` matched when outcome not in named branches', () => {
  it('routes to __other__ when no exact match', async () => {
    type DomainOutcomeExt = DomainOutcome | 'unexpected';
    const onFailure = vi.fn(async () => ({ id: 'close_lease' as const }));
    const spec: VerificationSpec<unknown, DomainOutcomeExt, DomainDiag> = {
      verifier: async () => ({
        outcome: 'mismatch',
        diagnostic: { actual: 'something' },
      }),
      successValues: ['match'],
      branches: {
        // mismatch deliberately NOT present; should fall through to __other__
        __other__: {
          branchId: 'unclassified',
          journalActionTags: ['verify-catchall'],
          buildFailureEnvelope: (d) => ({
            outcome: 'failed',
            reason: `caught by other: ${d.actual}`,
          }),
          buildRecoveryOptions: () => [
            { id: 'close_lease', label: 'Close', description: 'Close lease' },
          ],
        },
      },
    };
    const result = await verifyAndRecover(spec, {}, { onFailure });
    expect(result.branchId).toBe('unclassified');
    expect(result.journalActionTags).toEqual(['verify-catchall']);
    expect(result.failure?.reason).toBe('caught by other: something');
  });
});

describe('case 10 — no `__other__` and unrecognized outcome → synthesized unclassified', () => {
  it('synthesizes unclassified branch with empty RecoveryOption[] (inform-only)', async () => {
    const onFailure = vi.fn(async () => ({ id: 'close_lease' as const }));
    const spec: VerificationSpec<unknown, DomainOutcome, DomainDiag> = {
      verifier: async () => ({
        outcome: 'mismatch',
        diagnostic: { actual: 'something' },
      }),
      successValues: ['match'],
      // mismatch NOT present; no __other__; driver synthesizes unclassified.
      branches: {},
    };
    const result = await verifyAndRecover(spec, {}, { onFailure });
    expect(result.result).toBe('failure');
    expect(result.branchId).toBe('unclassified');
    expect(result.journalActionTags).toEqual(['verify-unclassified']);
    expect(result.failure?.outcome).toBe('failed');
    expect(result.failure?.reason).toMatch(/unrecognized; no branch matched/);
    // Inform-only — onFailure NOT invoked.
    expect(onFailure).not.toHaveBeenCalled();
    expect(result.recoveryChoice).toBeUndefined();
  });
});

describe('case 15 — restart-app success (typed outcome via name)', () => {
  it('treats string outcome as success when included in successValues', async () => {
    type RestartOutcome = 'LEASE_STATE_ACTIVE' | 'LEASE_STATE_CLOSED';
    interface RestartDiag {
      terminal: boolean;
    }
    const spec: VerificationSpec<unknown, RestartOutcome, RestartDiag> = {
      verifier: async () => ({
        outcome: 'LEASE_STATE_ACTIVE',
        diagnostic: { terminal: false },
      }),
      successValues: ['LEASE_STATE_ACTIVE'],
      branches: {
        __other__: {
          branchId: 'unclassified',
          journalActionTags: ['restart-post-verify-not-active'],
          buildFailureEnvelope: (d) => ({
            outcome: 'failed',
            reason: `Restart sent but terminal=${d.terminal}`,
          }),
          buildRecoveryOptions: () => [],
        },
      },
    };
    const result = await verifyAndRecover(spec, {});
    expect(result.result).toBe('success');
    expect(result.diagnostic).toEqual({ terminal: false });
  });
});

describe('case 16 — restart-app failure (CLOSED → branch matched)', () => {
  it('dispatches branch and binds typed diag into the envelope', async () => {
    type RestartOutcome = 'LEASE_STATE_ACTIVE' | 'LEASE_STATE_CLOSED';
    interface RestartDiag {
      terminal: boolean;
      name: string;
    }
    const spec: VerificationSpec<unknown, RestartOutcome, RestartDiag> = {
      verifier: async () => ({
        outcome: 'LEASE_STATE_CLOSED',
        diagnostic: { terminal: true, name: 'LEASE_STATE_CLOSED' },
      }),
      successValues: ['LEASE_STATE_ACTIVE'],
      branches: {
        __other__: {
          branchId: 'unclassified',
          journalActionTags: ['restart-post-verify-not-active'],
          buildFailureEnvelope: (d) => ({
            outcome: 'failed',
            reason: `Restart sent but state is now ${d.name}`,
          }),
          buildRecoveryOptions: () => [],
        },
      },
    };
    const result = await verifyAndRecover(spec, {});
    expect(result.result).toBe('failure');
    expect(result.branchId).toBe('unclassified');
    expect(result.failure?.reason).toBe(
      'Restart sent but state is now LEASE_STATE_CLOSED',
    );
  });
});

describe('case 17a — top-level denylist key in verifier diagnostic is stripped before reaching closures or result', () => {
  it('strips api_key and password from diagnostic; safe field flows through', async () => {
    let observedDiag: Record<string, unknown> | undefined;
    type T = 'ok' | 'bad';
    const spec: VerificationSpec<unknown, T, Record<string, unknown>> = {
      verifier: async () => ({
        outcome: 'ok',
        diagnostic: {
          api_key: 'should-be-stripped',
          password: 'also-stripped',
          actual: 'safe',
        },
      }),
      successValues: ['ok'],
      branches: {
        bad: {
          branchId: 'unclassified',
          journalActionTags: [],
          buildFailureEnvelope: (d) => {
            observedDiag = d;
            return { outcome: 'failed', reason: 'x' };
          },
          buildRecoveryOptions: () => [],
        },
      },
    };
    const result = await verifyAndRecover(spec, {});
    expect(result.result).toBe('success');
    expect(result.diagnostic).toEqual({ actual: 'safe' });
    expect(result.diagnostic).not.toHaveProperty('api_key');
    expect(result.diagnostic).not.toHaveProperty('password');
    expect(observedDiag).toBeUndefined(); // branch never invoked on success
  });
});

describe('case 17b — nested denylist keys stripped recursively', () => {
  it('strips api_key / password / private_key / auth_token at every depth', async () => {
    const spec: VerificationSpec<unknown, 'ok', Record<string, unknown>> = {
      verifier: async () => ({
        outcome: 'ok',
        diagnostic: {
          details: {
            api_key: 'nested-1',
            deeper: { password: 'nested-2', safe_field: 'kept' },
          },
          auth_token: 'top-strip',
          list: [{ private_key: 'in-array', other: 'kept' }, 'string-element'],
          actual: 'kept-top',
        },
      }),
      successValues: ['ok'],
      branches: {},
    };
    const result = await verifyAndRecover(spec, {});
    expect(result.diagnostic).toEqual({
      details: { deeper: { safe_field: 'kept' } },
      list: [{ other: 'kept' }, 'string-element'],
      actual: 'kept-top',
    });
    const stringified = JSON.stringify(result.diagnostic);
    expect(stringified).not.toMatch(/api_key/);
    expect(stringified).not.toMatch(/password/);
    expect(stringified).not.toMatch(/private_key/);
    expect(stringified).not.toMatch(/auth_token/);
  });
});

describe('case 17c — prototype-pollution keys in verifier diagnostic are skipped (no prototype mutation)', () => {
  it('skips __proto__ / constructor / prototype at every depth', async () => {
    // Use JSON.parse to materialize __proto__ as a real own property the
    // way a generic verifier deserializing user JSON would.
    const sourcePayload = JSON.parse(
      JSON.stringify({
        __proto__: { polluted_top: 'should-not-survive' },
        constructor: { polluted_via_constructor: 'x' },
        prototype: { polluted_via_prototype: 'x' },
        nested: { __proto__: { polluted_nested: 'x' }, safe: 'kept' },
        actual: 'kept',
      }),
    );
    const spec: VerificationSpec<unknown, 'ok', Record<string, unknown>> = {
      verifier: async () => ({
        outcome: 'ok',
        diagnostic: sourcePayload,
      }),
      successValues: ['ok'],
      branches: {},
    };
    const result = await verifyAndRecover(spec, {});
    expect(Object.getPrototypeOf(result.diagnostic as object)).toBe(
      Object.prototype,
    );
    const stringified = JSON.stringify(result.diagnostic);
    expect(stringified).not.toMatch(/polluted_top/);
    expect(stringified).not.toMatch(/polluted_via_constructor/);
    expect(stringified).not.toMatch(/polluted_via_prototype/);
    expect(stringified).not.toMatch(/polluted_nested/);
    expect(result.diagnostic).toEqual({
      nested: { safe: 'kept' },
      actual: 'kept',
    });
  });
});

describe('case 19 — verifier-result shape validation (TS equivalent of CJS "missing success.field key")', () => {
  it('throws when verifier returns null', async () => {
    const spec: VerificationSpec<unknown, 'ok', Record<string, unknown>> = {
      verifier: async () =>
        null as unknown as {
          outcome: 'ok';
          diagnostic: Record<string, unknown>;
        },
      successValues: ['ok'],
      branches: {},
    };
    await expect(verifyAndRecover(spec, {})).rejects.toThrow(
      /verifier must return an object/,
    );
  });

  it('throws when verifier result is missing the outcome string', async () => {
    const spec: VerificationSpec<unknown, 'ok', Record<string, unknown>> = {
      verifier: async () =>
        ({ diagnostic: {} }) as unknown as {
          outcome: 'ok';
          diagnostic: Record<string, unknown>;
        },
      successValues: ['ok'],
      branches: {},
    };
    await expect(verifyAndRecover(spec, {})).rejects.toThrow(
      /missing the required "outcome" string field/,
    );
  });

  it('throws when verifier result is missing diagnostic', async () => {
    const spec: VerificationSpec<unknown, 'ok', Record<string, unknown>> = {
      verifier: async () =>
        ({ outcome: 'ok' }) as unknown as {
          outcome: 'ok';
          diagnostic: Record<string, unknown>;
        },
      successValues: ['ok'],
      branches: {},
    };
    await expect(verifyAndRecover(spec, {})).rejects.toThrow(
      /missing a "diagnostic" object field/,
    );
  });
});

// Spec-shape guards (mirrors CJS spec-shape checks at end of test file)
describe('spec runtime-shape guards', () => {
  it('throws when spec.verifier is not a function', async () => {
    await expect(
      verifyAndRecover(
        {
          verifier: 'not-a-function' as unknown as Verifier<unknown, 'ok'>,
          successValues: ['ok'],
          branches: {},
        },
        {},
      ),
    ).rejects.toThrow(/spec\.verifier must be a function/);
  });

  it('throws when spec.successValues is not an array', async () => {
    await expect(
      verifyAndRecover(
        {
          verifier: async () => ({ outcome: 'ok' as const, diagnostic: {} }),
          successValues: 'ok' as unknown as readonly 'ok'[],
          branches: {},
        },
        {},
      ),
    ).rejects.toThrow(/spec\.successValues must be an array/);
  });

  it('throws when spec.branches is null (typeof null === "object" trap)', async () => {
    await expect(
      verifyAndRecover(
        {
          verifier: async () => ({ outcome: 'ok' as const, diagnostic: {} }),
          successValues: ['ok'],
          branches: null as unknown as Record<string, never>,
        },
        {},
      ),
    ).rejects.toThrow(/spec\.branches must be an object/);
  });

  it('throws when spec.branches is an array', async () => {
    await expect(
      verifyAndRecover(
        {
          verifier: async () => ({ outcome: 'ok' as const, diagnostic: {} }),
          successValues: ['ok'],
          branches: [] as unknown as Record<string, never>,
        },
        {},
      ),
    ).rejects.toThrow(/spec\.branches must be an object/);
  });
});

// =============================================================================
// Adapts — same behavior, TS-shaped differently from CJS
// =============================================================================

describe('adapt: typed diagnostic flows into buildRecoveryOptions (replaces CJS case 11 `{{var}}` interpolation)', () => {
  it("branch's buildRecoveryOptions reads typed diagnostic to render option descriptions", async () => {
    interface DomainDiag2 {
      actual: string;
      requestedFqdn: string;
    }
    let observedDiag: DomainDiag2 | undefined;
    const onFailure = vi.fn<
      (
        failure: FailureEnvelope,
        options: RecoveryOption[],
      ) => Promise<RecoveryChoice>
    >(async (_failure, options) => {
      observedDiag = undefined;
      // Stash the description that the closure bound from diag for the assertion.
      const opt = options[0];
      if (opt) {
        observedDiag = { actual: 'x', requestedFqdn: opt.description };
      }
      return { id: 'retry_set_domain' };
    });
    const spec: VerificationSpec<unknown, 'match' | 'mismatch', DomainDiag2> = {
      verifier: async () => ({
        outcome: 'mismatch',
        diagnostic: {
          actual: 'old.example.com',
          requestedFqdn: 'new.example.com',
        },
      }),
      successValues: ['match'],
      branches: {
        mismatch: {
          branchId: 'domain_verification_mismatch',
          journalActionTags: ['domain-verification-mismatch'],
          buildFailureEnvelope: (d) => ({
            outcome: 'partially_succeeded',
            leaseUuid: UUID,
            reason: `Chain shows ${d.actual} instead of ${d.requestedFqdn}`,
          }),
          buildRecoveryOptions: (d) => [
            {
              id: 'retry_set_domain',
              label: 'Retry',
              description: `Re-broadcast set-domain for ${d.requestedFqdn}`,
            },
          ],
        },
      },
    };
    await verifyAndRecover(spec, {}, { onFailure });
    expect(observedDiag?.requestedFqdn).toBe(
      'Re-broadcast set-domain for new.example.com',
    );
  });
});

describe('adapt: verifier throws → driver re-throws (replaces CJS case 12 subprocess-exit)', () => {
  it('propagates the verifier error unchanged', async () => {
    const spec: VerificationSpec<unknown, 'ok', Record<string, unknown>> = {
      verifier: async () => {
        throw new Error('boom');
      },
      successValues: ['ok'],
      branches: {},
    };
    await expect(verifyAndRecover(spec, {})).rejects.toThrow('boom');
  });
});

describe('adapt: failure with no onFailure callback → result carries failure envelope, no recoveryChoice', () => {
  it('returns failure result without invoking host', async () => {
    const spec: VerificationSpec<unknown, DomainOutcome, DomainDiag> = {
      verifier: domainVerifier({
        outcome: 'mismatch',
        diagnostic: { actual: 'old' },
      }),
      successValues: ['match'],
      branches: {
        mismatch: domainBranch(
          'domain_verification_mismatch',
          'tag',
          () => 'reason',
          STANDARD_OPTIONS,
        ),
      },
    };
    const result = await verifyAndRecover(spec, {}, {});
    expect(result.result).toBe('failure');
    expect(result.failure).toBeDefined();
    expect(result.recoveryChoice).toBeUndefined();
  });
});

describe('adapt: empty buildRecoveryOptions → onFailure NOT called (inform-only branches)', () => {
  it('skips host callback when branch returns no options', async () => {
    const onFailure = vi.fn<
      (
        failure: FailureEnvelope,
        options: RecoveryOption[],
      ) => Promise<RecoveryChoice>
    >(async () => ({ id: 'close_lease' }));
    const spec: VerificationSpec<unknown, DomainOutcome, DomainDiag> = {
      verifier: domainVerifier({
        outcome: 'mismatch',
        diagnostic: { actual: 'old' },
      }),
      successValues: ['match'],
      branches: {
        mismatch: domainBranch(
          'lease_terminal',
          'tag',
          () => 'reason',
          [], // <-- inform-only: empty options
        ),
      },
    };
    const result = await verifyAndRecover(spec, {}, { onFailure });
    expect(result.result).toBe('failure');
    expect(result.branchId).toBe('lease_terminal');
    expect(result.failure).toBeDefined();
    expect(onFailure).not.toHaveBeenCalled();
    expect(result.recoveryChoice).toBeUndefined();
  });
});

describe('adapt: success path — onFailure NOT called even when supplied', () => {
  it('skips host callback on success', async () => {
    const onFailure = vi.fn(async () => ({ id: 'close_lease' as const }));
    const spec: VerificationSpec<unknown, DomainOutcome, DomainDiag> = {
      verifier: domainVerifier({
        outcome: 'match',
        diagnostic: { actual: 'ok' },
      }),
      successValues: ['match'],
      branches: {},
    };
    await verifyAndRecover(spec, {}, { onFailure });
    expect(onFailure).not.toHaveBeenCalled();
  });
});

// =============================================================================
// it.skip set — subprocess-plumbing concerns N/A in the in-process TS port
// =============================================================================

describe('it.skip — CJS-only concerns N/A in the in-process TS port', () => {
  it.skip('case 6: stdin_source: null — N/A; TS verifier receives typed context, no stdin concept', () => {});
  it.skip('case 7: stdin_source names a key — N/A; no payload dict', () => {});
  it.skip('case 8: stdin_source key absent → exit 1 — N/A; no payload dict', () => {});
  it.skip('case 13: stdin not valid JSON → exit 1 — N/A; caller passes typed spec', () => {});
  it.skip('case 14a: verifier.script with `..` → exit 1 — N/A; no path, no sanitizeScriptName', () => {});
  it.skip('case 14b: verifier.script absolute path → exit 1 — N/A; no path', () => {});
  it.skip('case 14c: verifier.script with embedded slash → exit 1 — N/A; no path', () => {});
  it.skip('case 14d: verifier.script === "." → exit 1 — N/A; no path / isFile check', () => {});
  it.skip('case 18a: verifier stdout is JSON array → exit 1 — N/A; verifier returns typed object', () => {});
  it.skip('case 18b: verifier stdout is JSON null → exit 1 — N/A; typed return', () => {});
  it.skip('case 18c: verifier stdout is JSON string → exit 1 — N/A; typed return', () => {});
  it.skip('case 18d: verifier produces empty stdout → exit 1 — N/A; typed return', () => {});
  it.skip('case 20: VERIFY_RECOVER_TEST_SCRIPTS_DIR ignored when NODE_ENV !== test — N/A; no env-var override', () => {});
  it.skip('case 21: VERIFY_RECOVER_TEST_SCRIPTS_DIR ignored when NODE_ENV unset — N/A; no env-var override', () => {});
  it.skip('case 22: verifier exceeds VERIFIER_TIMEOUT_MS → exit 1 (ETIMEDOUT) — N/A; no subprocess', () => {});
  it.skip('case 23: verifier stdout exceeds VERIFIER_MAX_BUFFER → exit 1 (ENOBUFS) — N/A; no subprocess', () => {});
});
