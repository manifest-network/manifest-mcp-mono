/**
 * Classify the MCP error envelope thrown by `mcp__manifest-fred__deploy_app`
 * when the call fails AFTER the create-lease tx already confirmed.
 *
 * 1:1 port of `manifest-agent-plugin/scripts/classify-deploy-error.cjs`.
 * Companion to `classify-deploy-response.ts`: that file handles the RETURN
 * path; this file handles the THROW path. The split exists because
 * `manifest-mcp-fred` 0.8.0 `deployApp` throws `ManifestMCPError` with the
 * message prefix `Deploy partially succeeded: lease ${uuid} was created
 * but subsequent steps failed.` and `details.lease_uuid` populated when
 * create-lease succeeded but something downstream (set-domain, manifest
 * upload, readiness poll) fell over.
 *
 * Recognised input envelope shapes:
 *   - `{ message, details?, code? }`
 *   - `{ error: { message, details?, code? } }`
 *
 * Returns deterministically — never throws. A malformed envelope is
 * classified as `outcome: 'failed'` with a stable `reason`, so the
 * orchestrator can branch on the JSON without an outer try/catch.
 *
 * `outcome: 'partially_succeeded'` triggers ONLY when `err.message` starts
 * with the exact prefix `Deploy partially succeeded:`. Looser matching
 * would risk false positives on wrapper errors that happen to contain the
 * phrase nested inside other text.
 */

/** Permissive UUID pattern (RFC-4122 8-4-4-4-12, version byte lenient). */
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const PARTIAL_PREFIX = 'Deploy partially succeeded:';

export interface DeployErrorClassification {
  outcome: 'partially_succeeded' | 'failed';
  /** Present when create-lease confirmed (outcome partially_succeeded), or when a UUID was extractable from a non-partial error. */
  leaseUuid?: string;
  /** Echoed from `opts.expectedCustomDomain` so downstream prompts can name the FQDN. */
  requestedCustomDomain?: string;
  /** Human-readable summary — the raw error message (or a stable placeholder if missing). */
  reason: string;
}

/**
 * Pick the inner envelope when the error is wrapped as `{ error: {...} }`.
 * `JSON.stringify(err)` produces this shape in some SDKs.
 */
function pickEnvelope(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object') {
    const r = raw as { error?: unknown };
    if (r.error !== null && typeof r.error === 'object') return r.error;
  }
  return raw;
}

export function classifyDeployError(
  err: unknown,
  opts: { expectedCustomDomain?: string } = {},
): DeployErrorClassification {
  const expectedCustomDomain = opts.expectedCustomDomain;
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

  const envelope = e as { message?: unknown; details?: unknown };
  const message = typeof envelope.message === 'string' ? envelope.message : '';
  const details =
    envelope.details !== null &&
    typeof envelope.details === 'object' &&
    !Array.isArray(envelope.details)
      ? (envelope.details as { lease_uuid?: unknown })
      : {};

  // Partial-success trigger: EXACT upstream prefix. Anything looser risks
  // mis-classifying wrapper errors whose message merely contains the
  // phrase as a substring (defended by case #5 in the CJS test).
  if (message.startsWith(PARTIAL_PREFIX)) {
    let leaseUuid: string | undefined;
    if (typeof details.lease_uuid === 'string') {
      leaseUuid = details.lease_uuid;
    } else {
      const m = message.match(UUID_PATTERN);
      if (m) leaseUuid = m[0];
    }
    return finalize(
      {
        outcome: 'partially_succeeded',
        ...(leaseUuid !== undefined && { leaseUuid }),
        reason: message,
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
