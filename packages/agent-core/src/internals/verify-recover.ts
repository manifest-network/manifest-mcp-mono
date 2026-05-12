import type {
  FailureEnvelope,
  RecoveryChoice,
  RecoveryOption,
} from '../types.js';
import { stripDenylist } from './secret-denylist.js';

/**
 * In-process verify-and-recover driver. Port of
 * `manifest-agent-plugin/scripts/verify-recover.cjs` (the generic driver
 * ENG-123 shipped on the plugin side). The CJS shells out to a named
 * verifier script via `spawnSync`; the TS port replaces that with an
 * inline async verifier function (L7: agent-core MUST NOT spawn
 * subprocesses).
 *
 * Drops (subprocess-only concerns, see ENG-129 ticket §"What ENG-123
 * actually shipped"):
 *   - `spec.verifier.script` path sanitization (no path; verifier is a function)
 *   - `spec.verifier.stdin_source` indirection (verifier receives typed context)
 *   - `spec.verifier.args` argv interpolation (verifier closes over context)
 *   - `{{var}}` template interpolation on user_message (recovery options
 *     carry their own typed-diagnostic closures via `buildRecoveryOptions`)
 *   - `timeout` / `maxBuffer` operational caps (no subprocess; an optional
 *     AbortController-based timeout can be added per-verifier if needed)
 *   - `NODE_ENV` test-override env vars (none of the above need them)
 *
 * Keeps (in-process security still relevant):
 *   - `SECRET_KEY_DENYLIST` strip on the diagnostic before it reaches
 *     `buildFailureEnvelope` / `buildRecoveryOptions` / the host callback / the result.
 *   - Prototype-pollution guard on `__proto__` / `constructor` / `prototype`
 *     in the diagnostic walk (defense for verifier-output objects that
 *     could have come via `JSON.parse`).
 *   - Branch dispatch: `branches[outcome]` → `branches.__other__` →
 *     synthesized `unclassified` fallback (CJS calls it `'other'`; the TS
 *     port uses `'__other__'` to avoid collisions with a literal outcome
 *     string `'other'`).
 *
 * Branch IDs are an internal, closed-set string-literal union — they
 * identify branches for journal/logging purposes but are NOT part of the
 * public type contract (Option A from ENG-128). The public surface for
 * recovery is the frozen `RecoveryOption[]` array, materialized by each
 * branch's inline `buildRecoveryOptions(diag)` closure.
 */

/** Closed-set internal branch identifier. Surfaces via journal/log only. */
export type BranchId =
  | 'partial_success_domain'
  | 'lease_terminal'
  | 'domain_verification_mismatch'
  | 'pending_drift'
  | 'unclassified';

/**
 * Per-branch behavior contract. Authored inline at each high-level
 * function's call site (deployApp, manageDomain, etc.) so the closures
 * can bind diagnostic data into the surfaced label/description text.
 */
export interface VerificationBranch<TDiag = Record<string, unknown>> {
  /** Internal id for journal write + log; not surfaced to host callbacks directly. */
  readonly branchId: BranchId;
  /** Pass-through tags for the ENG-124 journal `recovery_actions[]`. Empty when not journaling. */
  readonly journalActionTags: readonly string[];
  /** Synthesize the public `FailureEnvelope` (frozen contract) from the post-strip diagnostic. */
  buildFailureEnvelope: (diagnostic: TDiag) => FailureEnvelope;
  /**
   * Materialize the `RecoveryOption[]` for the host's `onFailure` callback.
   * Returning an empty array marks the branch as inform-only:
   * `verifyAndRecover` will return the failure envelope without invoking
   * `onFailure` so callers don't waste a user prompt asking what to do
   * when there's nothing to choose between.
   */
  buildRecoveryOptions: (diagnostic: TDiag) => RecoveryOption[];
}

/** Verifier function — async; receives typed context; returns typed outcome + free-form diagnostic. */
export type Verifier<
  TContext,
  TOutcome extends string,
  TDiag = Record<string, unknown>,
> = (context: TContext) => Promise<VerifierResult<TOutcome, TDiag>>;

/** Shape returned by every verifier. `outcome` drives branch selection; `diagnostic` flows into the branch's closures. */
export interface VerifierResult<TOutcome extends string, TDiag> {
  outcome: TOutcome;
  diagnostic: TDiag;
}

/**
 * Verification spec — declarative description of how to verify post-state
 * and dispatch to a recovery branch. Mirrors the CJS spec shape with
 * the subprocess-specific fields dropped.
 *
 * `__other__` is the catch-all branch key, equivalent to the CJS's `'other'`.
 * Renamed to avoid collisions with an outcome literally equal to `'other'`.
 */
export interface VerificationSpec<
  TContext,
  TOutcome extends string,
  TDiag = Record<string, unknown>,
> {
  readonly verifier: Verifier<TContext, TOutcome, TDiag>;
  /** Outcome values that count as success — no branch dispatch, host's `onFailure` is NOT called. */
  readonly successValues: readonly TOutcome[];
  /** Branch dictionary keyed by outcome string. `__other__` is the catch-all fallback. */
  readonly branches: Partial<
    Record<TOutcome | '__other__', VerificationBranch<TDiag>>
  >;
}

export interface VerifyAndRecoverResult<
  TOutcome extends string,
  TDiag = Record<string, unknown>,
> {
  result: 'success' | 'failure';
  verifierOutcome: TOutcome;
  /** `null` on success; the matched branch's id (or `'unclassified'`) on failure. */
  branchId: BranchId | null;
  journalActionTags: readonly string[];
  /** Post-strip diagnostic. Same value the branch closures received. */
  diagnostic: TDiag;
  /** Present iff failure. The synthesized public-surface envelope. */
  failure?: FailureEnvelope;
  /** Present iff failure AND `onFailure` was called AND it returned (i.e., a non-empty `RecoveryOption[]` was presented). */
  recoveryChoice?: RecoveryChoice;
}

export interface VerifyAndRecoverCallbacks {
  /**
   * Rich-form failure handler used by `deployApp`. Receives the
   * `FailureEnvelope` synthesized by the matched branch + the closure-
   * built `RecoveryOption[]` and returns the user's pick.
   *
   * Simple-form callers (manageDomain / closeLease / troubleshoot) wrap
   * via an adapter in PR 4 — they don't pass an `onFailure` here directly.
   */
  onFailure?: (
    failure: FailureEnvelope,
    options: RecoveryOption[],
  ) => Promise<RecoveryChoice>;
}

/**
 * Run the verifier; classify the outcome; on failure, build the public
 * envelope + recovery options and (optionally) invoke the host's
 * `onFailure` callback for a user pick.
 *
 * Throws synchronously on:
 *   - Spec runtime-shape violations (missing verifier function, non-array
 *     successValues, non-object branches).
 *   - Verifier-returned shape violations (missing `outcome` key,
 *     non-string `outcome`, missing `diagnostic` key, non-object
 *     `diagnostic`).
 * Propagates any error the verifier itself throws.
 */
export async function verifyAndRecover<
  TContext,
  TOutcome extends string,
  TDiag = Record<string, unknown>,
>(
  spec: VerificationSpec<TContext, TOutcome, TDiag>,
  context: TContext,
  callbacks: VerifyAndRecoverCallbacks = {},
): Promise<VerifyAndRecoverResult<TOutcome, TDiag>> {
  validateSpec(spec);

  const verifierResult = await spec.verifier(context);
  validateVerifierResult(verifierResult);

  // Strip secret-shaped keys + prototype-pollution keys from the
  // diagnostic BEFORE it flows into any branch closure, host callback,
  // or the result object. The strip is the same posture `_journal.cjs`'s
  // `validateRecord` enforces on the write side.
  const diagnostic = stripDenylist(verifierResult.diagnostic) as TDiag;
  const outcome = verifierResult.outcome;

  const isSuccess = spec.successValues.includes(outcome);
  if (isSuccess) {
    return {
      result: 'success',
      verifierOutcome: outcome,
      branchId: null,
      journalActionTags: [],
      diagnostic,
    };
  }

  // Failure path: dispatch to named branch, `__other__` fallback, or
  // synthesized `unclassified`.
  const branch = selectBranch<TOutcome, TDiag>(spec.branches, outcome);
  const failure = branch.buildFailureEnvelope(diagnostic);
  const options = branch.buildRecoveryOptions(diagnostic);

  // Inform-only branches (lease_terminal, unclassified) return [] for
  // RecoveryOption[]. Surface the failure envelope without prompting
  // the host — there's no choice to present.
  if (options.length === 0 || callbacks.onFailure === undefined) {
    return {
      result: 'failure',
      verifierOutcome: outcome,
      branchId: branch.branchId,
      journalActionTags: branch.journalActionTags,
      diagnostic,
      failure,
    };
  }

  const recoveryChoice = await callbacks.onFailure(failure, options);
  return {
    result: 'failure',
    verifierOutcome: outcome,
    branchId: branch.branchId,
    journalActionTags: branch.journalActionTags,
    diagnostic,
    failure,
    recoveryChoice,
  };
}

function validateSpec<TContext, TOutcome extends string, TDiag>(
  spec: VerificationSpec<TContext, TOutcome, TDiag>,
): void {
  if (spec === null || typeof spec !== 'object') {
    throw new Error('verifyAndRecover: spec must be an object');
  }
  if (typeof spec.verifier !== 'function') {
    throw new Error('verifyAndRecover: spec.verifier must be a function');
  }
  if (!Array.isArray(spec.successValues)) {
    throw new Error('verifyAndRecover: spec.successValues must be an array');
  }
  // `typeof null === 'object'` would otherwise let a `branches: null` value
  // slip past a bare typeof check and silently route every failure through
  // the synthesized `unclassified` branch. Explicit guard mirrors the
  // CJS's null-check at line 256-263 of verify-recover.cjs.
  if (
    spec.branches === null ||
    typeof spec.branches !== 'object' ||
    Array.isArray(spec.branches)
  ) {
    throw new Error('verifyAndRecover: spec.branches must be an object');
  }
}

function validateVerifierResult(
  value: unknown,
): asserts value is VerifierResult<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'verifyAndRecover: verifier must return an object with shape { outcome, diagnostic }',
    );
  }
  const r = value as { outcome?: unknown; diagnostic?: unknown };
  if (typeof r.outcome !== 'string') {
    throw new Error(
      'verifyAndRecover: verifier result is missing the required "outcome" string field',
    );
  }
  if (
    r.diagnostic === null ||
    typeof r.diagnostic !== 'object' ||
    Array.isArray(r.diagnostic)
  ) {
    throw new Error(
      'verifyAndRecover: verifier result is missing a "diagnostic" object field',
    );
  }
}

function selectBranch<TOutcome extends string, TDiag>(
  branches: Partial<Record<TOutcome | '__other__', VerificationBranch<TDiag>>>,
  outcome: TOutcome,
): VerificationBranch<TDiag> {
  const named = branches[outcome];
  if (named !== undefined) return named;
  const other = branches.__other__;
  if (other !== undefined) return other;
  return synthesizeUnclassified<TDiag>(outcome);
}

/**
 * Fabricate the `unclassified` fallback when no named branch and no
 * `__other__` catch-all match. Mirrors the CJS behavior at line 222-232:
 * journal action tag is `verify-unclassified`; the recovery options list
 * is empty (inform-only); the failure envelope conveys the unrecognized
 * outcome verbatim in `reason`.
 */
function synthesizeUnclassified<TDiag>(
  outcome: string,
): VerificationBranch<TDiag> {
  return {
    branchId: 'unclassified',
    journalActionTags: ['verify-unclassified'],
    buildFailureEnvelope: () => ({
      outcome: 'failed',
      reason: `Verifier returned outcome '${outcome}' — unrecognized; no branch matched.`,
    }),
    buildRecoveryOptions: () => [],
  };
}
