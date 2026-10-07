import {
  type FRED_FAILURE_REASONS,
  type FredFailureReason,
  isKnownFailureReason,
} from './failure-reason.js';

/**
 * Who can ACT on a failure — deliberately not "who caused it".
 *
 * The single most valuable cell in the table: an assistant handed only
 * `reason: "VolumeCleanupExhausted"` will cheerfully tell the tenant to retry a
 * deployment they cannot possibly fix.
 *
 * The two axes come apart, and conflating them produced a real contradiction
 * (a table row advising `restart_app` while the prompt said the reason was
 * unactionable). `Internal` is provider-CAUSED — nothing about the tenant's
 * workload is at fault — but tenant-ACTIONABLE, because retrying a transient
 * internal error is exactly the right move. It is `actor: 'tenant'`. Blame
 * belongs in `explanation`; this field is only ever about who can do something.
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
  HealthCheckFailed: {
    explanation:
      'A container health check never passed during startup: it reported unhealthy, or was still not healthy at the startup deadline (Fred PR #255). This never counts toward the provider closing the lease, so an ACTIVE lease is re-provisioned, and billed, on every pass until you fix it.',
    nextStep:
      'Call get_logs({ lease_uuid, tail: 200 }) to see why the app is not healthy, then fix the app or its health_check (start_period must cover startup) and update_app. Close the lease with close_lease (manifest-mcp-lease) if you no longer need it.',
    actor: 'tenant',
  },
  ContainerStartFailed: {
    explanation:
      'The container runtime refused to start a container, so it never ran: for example, its entrypoint or command does not exist in the image (Fred PR #255). This never counts toward the provider closing the lease, so an ACTIVE lease is re-provisioned, and billed, on every pass until you fix it.',
    nextStep:
      'Check the image entrypoint and the manifest command and args (get_logs is usually empty because nothing ran), fix them or the image, and update_app. Close the lease with close_lease (manifest-mcp-lease) if you no longer need it.',
    actor: 'tenant',
  },
  ImagePullFailed: {
    explanation:
      'The provider could not pull or admit the image: a wrong or private reference, a non-HTTPS registry, an image over the provider size budget or 128 layers, no manifest for its platform, unsupported layer contents, or a registry rate limit or stall (Fred PR #242 admission). If app_status reports ready, the previous release is still running.',
    nextStep:
      'Check the image reference is exact and publicly pullable over HTTPS — no private-registry credentials are available to the provider. If it is, slim or rebuild the image within the provider limits and update_app with a new reference, preferably a digest; a registry rate limit clears on a later attempt.',
    actor: 'tenant',
    // A failed update keeps the previous release running with this reason.
    mayBeHistorical: true,
  },
  Internal: {
    explanation:
      'An internal provider error. Nothing about the deployed workload is at fault — but a retry is still worth making, because these are often transient.',
    // Provider-CAUSED, tenant-ACTIONABLE. See FredFailureActor: `actor` is about
    // who can do something, not who is to blame.
    nextStep:
      'Retry with restart_app. If it recurs, the provider is unhealthy: pick a different one via browse_catalog, or escalate to the operator with the lease UUID.',
    actor: 'tenant',
  },
  RestartFailed: {
    explanation: 'A requested restart did not complete.',
    nextStep:
      'Check app_status first — the app may have recovered on its own. If not, get_logs for the crash trace before retrying restart_app.',
    actor: 'tenant',
  },
  UpdateFailed: {
    explanation:
      'A manifest update failed. If app_status reports ready, the previous deployment remains available; otherwise recovery may also have failed.',
    nextStep:
      'Do not redeploy blindly: that would risk a working deployment. Compare against the running release with app_releases, fix the manifest, then update_app again.',
    actor: 'tenant',
    mayBeHistorical: true,
  },
  RestoreFailed: {
    explanation: 'A restore from retained data did not complete.',
    nextStep:
      'Inspect app_status and app_diagnostics for both the SOURCE and any existing restore TARGET before retrying. The source must report retained; check retained_until when present. Its absence can mean age-based expiry is disabled. Preserve an existing target while its outcome is uncertain.',
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
  BackendStorageLost: {
    explanation:
      "The provider operator retired this lease's backend because its storage was irrecoverably lost (Fred PR #243). The app and its data on that provider are gone. The provider ends the lease on chain only in a later reconciliation sweep, so it can still be ACTIVE and billing: check app_status chainState.",
    // Provider-side: nothing recovers this lease or its data. A fresh deployment
    // is a new lease, not a retry, so the dead-end phrase still applies. Fred can
    // report this reason while the lease is ACTIVE (its lost_lease_test), and its
    // reconciler may defer the chain close, so closing is cleanup, not recovery.
    nextStep:
      'No tenant action exists to recover this lease or its data: restart_app, update_app, and restore_app all fail for it. Deploy a fresh lease with deploy_app and restore your data from your own backups. While app_status still shows this lease ACTIVE, you can close it with close_lease (manifest-mcp-lease) instead of waiting for the provider.',
    actor: 'provider',
  },
  VolumeDeletePending: {
    explanation:
      "The provider refused to provision because an earlier deletion of this lease's own volume is still finishing (Fred PR #250). It is provider-side and transient.",
    nextStep:
      'No tenant action exists: nothing you retry can hasten the deletion, and later provisioning attempts can succeed once it completes. If the lease stays failed with this reason, report the lease UUID to the provider operator.',
    actor: 'provider',
  },
  VolumeDeletionInProgress: {
    explanation:
      'The lease is closing and the provider is still deleting its volume (Fred PR #250). This is progress, not a failure: the close completes when the deletion does.',
    nextStep:
      'No tenant action exists: wait for the close to complete. If it does not, report the lease UUID to the provider operator.',
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
