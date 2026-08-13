import {
  type FRED_FAILURE_REASONS,
  type FredFailureReason,
  isKnownFailureReason,
} from './failure-reason.js';

/**
 * Who can act on a failure.
 *
 * The single most valuable cell in the table: an assistant handed only
 * `reason: "VolumeCleanupExhausted"` will cheerfully tell the tenant to retry a
 * deployment they cannot possibly fix.
 */
export type FredFailureActor = 'tenant' | 'provider';

export interface FredReasonGuidance {
  /** One plain-language sentence: what this failure means. */
  readonly explanation: string;
  /** ONE concrete next step, naming the tool to reach for. */
  readonly nextStep: string;
  /** Whether the tenant can act at all, or this is provider-side. */
  readonly actor: FredFailureActor;
  /**
   * True when this reason can be present on a lease that is currently HEALTHY.
   * Fred retains the failure attribution on a `ready` lease whose last update
   * rolled back, so guidance for these must not assume the app is down.
   */
  readonly mayBeHistorical?: boolean;
}

/**
 * Curated guidance for the failure reasons this client knows (ENG-638).
 *
 * `Record<(typeof FRED_FAILURE_REASONS)[number], …>` is deliberate: adding a
 * value to `FRED_FAILURE_REASONS` fails the build until its row exists here.
 * That is a completeness check over OUR list, not over Fred's — Fred's set is
 * open, so `guidanceFor` returns `undefined` for anything unlisted and callers
 * fall back to the human message.
 */
export const FRED_REASON_GUIDANCE: Readonly<
  Record<(typeof FRED_FAILURE_REASONS)[number], FredReasonGuidance>
> = {
  ContainerExited: {
    explanation:
      'A container exited unexpectedly — a crash, a non-zero exit, or an out-of-memory kill.',
    nextStep:
      'Call get_logs({ lease_uuid, tail: 200 }) and read the lines just before the exit. Fix the entrypoint or config and update_app; if it was OOM-killed, redeploy on a larger SKU instead.',
    actor: 'tenant',
  },
  ImagePullFailed: {
    explanation: 'The provider could not pull the container image.',
    nextStep:
      'Check the image reference is exact and publicly pullable — no private-registry credentials are available to the provider — then update_app with a corrected image.',
    actor: 'tenant',
  },
  Internal: {
    explanation:
      'An internal provider error. This is not attributable to the deployed workload.',
    nextStep:
      'Retry with restart_app. If it recurs, the provider is unhealthy: pick a different one via browse_catalog, or escalate to the operator with the lease UUID.',
    actor: 'provider',
  },
  RestartFailed: {
    explanation: 'A requested restart did not complete.',
    nextStep:
      'Check app_status first — the app may have recovered on its own. If not, get_logs for the crash trace before retrying restart_app.',
    actor: 'tenant',
  },
  UpdateFailed: {
    explanation:
      'A manifest update failed and was rolled back. The app is still running the PREVIOUS version — it is not down.',
    nextStep:
      'Do not redeploy blindly: that would risk a working deployment. Compare against the running release with app_releases, fix the manifest, then update_app again.',
    actor: 'tenant',
    mayBeHistorical: true,
  },
  RestoreFailed: {
    explanation: 'A restore from retained data did not complete.',
    nextStep:
      'Call app_status on the SOURCE lease and check retained_until. If the grace window is still open you can retry restore_app; once it has passed the retained data is gone.',
    actor: 'tenant',
  },
  VolumeCleanupExhausted: {
    explanation:
      'Volume cleanup on deprovision failed after exhausting every retry — a provider-side storage problem.',
    nextStep:
      'No tenant action exists. Report the lease UUID to the provider operator if billing continues or the data must be purged.',
    actor: 'provider',
  },
  CleanupFailed: {
    explanation:
      'Cleanup of containers or volumes on deprovision failed. The lease itself is closed.',
    nextStep:
      'No tenant action exists. Report the lease UUID to the provider operator if resources appear to be leaking.',
    actor: 'provider',
  },
  Unknown: {
    explanation:
      'The lease is marked failed but the provider recorded no specific cause.',
    nextStep:
      'Call get_logs({ lease_uuid, tail: 200 }) — container output is the only remaining signal. If it is empty, the failure happened before the container started.',
    actor: 'tenant',
  },
};

/**
 * Curated guidance for a raw wire `reason`, or `undefined` when this client
 * does not recognize it.
 *
 * The `isKnownFailureReason` gate is load-bearing: indexing
 * `FRED_REASON_GUIDANCE` with an unnarrowed string type-checks against a
 * non-optional value type and returns `undefined` at runtime — a lie the
 * compiler endorses. `undefined` here is the normal, expected result for a
 * reason from a newer Fred; callers fall back to the human message.
 */
export function guidanceFor(
  reason: FredFailureReason | undefined,
): FredReasonGuidance | undefined {
  if (reason === undefined || !isKnownFailureReason(reason)) return undefined;
  return FRED_REASON_GUIDANCE[reason];
}
