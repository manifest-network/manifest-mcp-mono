/**
 * Classify the MCP error envelope thrown by `mcp__manifest-fred__deploy_app`
 * when the call fails AFTER the create-lease tx already confirmed.
 *
 * Companion to `classify-deploy-response.ts`: that file handles the RETURN
 * path; this file handles the THROW path. The split exists because
 * `manifest-mcp-fred`'s `deployApp` throws `ManifestMCPError` with
 * `details.lease_uuid` populated when create-lease succeeded but something
 * downstream (set-domain, manifest upload, readiness poll) fell over. The
 * partial-success signal is carried structurally as `details.partial === true`
 * (ENG-280); the legacy `Deploy partially succeeded: lease ${uuid} was created
 * but subsequent steps failed.` message prefix is retained as a cross-version
 * fallback for fred builds that predate the structured flag.
 *
 * Recognised input envelope shapes:
 *   - `{ message, details?, code? }`
 *   - `{ error: { message, details?, code? } }`
 *
 * Returns deterministically — never throws. A malformed envelope is
 * classified as `outcome: 'failed'` with a stable `reason`, so the
 * orchestrator can branch on the JSON without an outer try/catch.
 *
 * `outcome: 'partially_succeeded'` triggers primarily on the structured
 * `details.partial === true` discriminant. As a fallback (for fred builds
 * without the flag) it also triggers when `err.message` starts with the exact
 * prefix `Deploy partially succeeded:`. The prefix match is EXACT-start only:
 * looser matching would risk false positives on wrapper errors that happen to
 * contain the phrase nested inside other text.
 */

import { diagnosticField } from './error-diagnostics.js';

/** Permissive UUID pattern (RFC-4122 8-4-4-4-12, version byte lenient). */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const PARTIAL_PREFIX = 'Deploy partially succeeded:';

/** The `deployManifest` step that failed, as reported in `details.failedStep`. */
export type DeployFailedStep = 'set_domain' | 'upload' | 'poll';

const FAILED_STEPS: readonly DeployFailedStep[] = [
  'set_domain',
  'upload',
  'poll',
];

export interface DeployErrorClassification {
  outcome: 'partially_succeeded' | 'failed';
  /** Present when create-lease confirmed (outcome partially_succeeded), or when a UUID was extractable from a non-partial error. */
  leaseUuid?: string;
  /** Echoed from `opts.expectedCustomDomain` so downstream prompts can name the FQDN. */
  requestedCustomDomain?: string;
  /** Human-readable summary — the raw error message (or a stable placeholder if missing). */
  reason: string;
  /**
   * `details.readiness_unconfirmed === true`: the lease exists AND the manifest
   * was uploaded, but the readiness poll never got a verdict. NOT a reported
   * failure — the app may be starting (ENG-661). Absent on fred builds that
   * predate the flag, which then fall back to today's behaviour.
   */
  readinessUnconfirmed?: boolean;
  /** `details.failedStep`, when it is one of the known steps. */
  failedStep?: DeployFailedStep;
}

/**
 * Pick the inner envelope when the error is wrapped as `{ error: {...} }`.
 * `JSON.stringify(err)` produces this shape in some SDKs.
 */
function pickEnvelope(raw: unknown): unknown {
  const inner = diagnosticField(raw, 'error');
  if (inner !== null && typeof inner === 'object') return inner;
  return raw;
}

function envelopeDetails(envelope: unknown): unknown {
  const details = diagnosticField(envelope, 'details');
  try {
    return details !== null &&
      typeof details === 'object' &&
      !Array.isArray(details)
      ? details
      : undefined;
  } catch {
    return undefined;
  }
}

export function classifyDeployError(
  err: unknown,
  opts: { expectedCustomDomain?: string } = {},
): DeployErrorClassification {
  const rawDomain = diagnosticField(opts, 'expectedCustomDomain');
  const expectedCustomDomain =
    typeof rawDomain === 'string' ? rawDomain : undefined;
  const e = pickEnvelope(err);

  if (e === null || typeof e !== 'object') {
    return finalize(
      {
        outcome: 'failed',
        reason: 'stdin envelope is not an object',
      },
      expectedCustomDomain,
    );
  }

  const rawMessage = diagnosticField(e, 'message');
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  const details = envelopeDetails(e);

  // Partial-success trigger: structured `details.partial === true`
  // discriminant (the ENG-280 split surfaces it on the partial-success wrap),
  // OR the EXACT legacy upstream prefix as a fallback. The prefix path stays
  // EXACT-start: anything looser risks mis-classifying wrapper errors whose
  // message merely contains the phrase as a substring (defended by case #5 in
  // the CJS test). `=== true` is strict to preserve the anti-false-positive
  // discipline (a truthy-but-non-`true` flag must not trigger cleanup).
  const partialFlag = diagnosticField(details, 'partial') === true;
  if (partialFlag || message.startsWith(PARTIAL_PREFIX)) {
    let leaseUuid: string | undefined;
    const rawLeaseUuid = diagnosticField(details, 'lease_uuid');
    if (typeof rawLeaseUuid === 'string') {
      leaseUuid = rawLeaseUuid;
    } else {
      const m = message.match(UUID_PATTERN);
      if (m) leaseUuid = m[0];
    }
    // Structural only — no message sniffing. A fred build that sends neither
    // flag classifies exactly as it did before (ENG-661). `=== true` is strict
    // for the same anti-false-positive reason as `partial` above: a
    // truthy-but-not-`true` value must not soften destructive advice.
    const readinessUnconfirmed =
      diagnosticField(details, 'readiness_unconfirmed') === true;
    const rawStep = diagnosticField(details, 'failedStep');
    const failedStep = FAILED_STEPS.find((s) => s === rawStep);
    return finalize(
      {
        outcome: 'partially_succeeded',
        ...(leaseUuid !== undefined && { leaseUuid }),
        ...(readinessUnconfirmed && { readinessUnconfirmed: true }),
        ...(failedStep !== undefined && { failedStep }),
        // `details.partial` can trigger this path with an empty envelope
        // message; fall back to a stable placeholder, matching the
        // failed-path contract ("raw error message, or a placeholder if missing").
        reason: message || 'deploy partially succeeded; lease was created',
      },
      expectedCustomDomain,
    );
  }

  // Anything else: terminal failure — the create-lease tx didn't confirm,
  // or the error happened before broadcast.
  return finalize(
    {
      outcome: 'failed',
      reason: message || 'deploy_app threw an empty error',
    },
    expectedCustomDomain,
  );
}

function finalize(
  base: DeployErrorClassification,
  expectedCustomDomain: string | undefined,
): DeployErrorClassification {
  if (expectedCustomDomain !== undefined) {
    return { ...base, requestedCustomDomain: expectedCustomDomain };
  }
  return base;
}
