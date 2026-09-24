type Operation = 'restart' | 'update';

/**
 * Fred v0.13.0 (8f0cbd94), devnet only. Its backend actor rejects an invalid
 * restart/update before launching the worker (leasesm/lease_actor.go), and the
 * provider maps that exact refusal to 409 (internal/api/handlers.go). There is
 * no command-key deduplication: never retry an uncertain or accepted request.
 */
export async function submitLegacyDevnetMaintenance<T>(options: {
  operation: Operation;
  submit: () => Promise<T>;
  reconcile: () => Promise<boolean>;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await options.submit();
    } catch (error) {
      if (!legacyAdmissionRefusal(error, options.operation) || attempt === 4)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      if (!(await options.reconcile().catch(() => false))) throw error;
    }
  }
}

function legacyAdmissionRefusal(error: unknown, operation: Operation): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const failure = error as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    kind?: unknown;
    message?: unknown;
    details?: Record<string, unknown>;
    cause?: { code?: unknown };
  };
  const details = failure.details;
  const classified =
    failure.code === 'MAINTENANCE_REQUEST_FAILED' ||
    (failure.name === 'ProviderApiError' &&
      failure.status === 409 &&
      failure.kind === 'http' &&
      failure.cause?.code === 'MAINTENANCE_REQUEST_FAILED');
  if (
    !classified ||
    details?.provider_status !== 409 ||
    details.provider_error_kind !== 'http' ||
    details.operation !== operation ||
    details.outcome !== 'unknown' ||
    details.idempotency_key !== undefined ||
    typeof failure.message !== 'string'
  )
    return false;
  const marker = failure.message.lastIndexOf(' Cause: ');
  try {
    const body = JSON.parse(
      marker === -1 ? failure.message : failure.message.slice(marker + 8),
    );
    return body.code === 409 && body.error === `invalid state for ${operation}`;
  } catch {
    return false;
  }
}

/**
 * Devnet harness only, tied to Fred f000babe (PR #242). Never use this policy
 * for an unknown provider or an earlier uncertain attempt. Recognized answers
 * for the current key (placement/maintenance_application.go, api/handlers.go):
 * - 409 claim-busy: other lifecycle work held the lease before this command was
 *   journaled, so the original key can be retried.
 * - 409 invalid state: a durable terminal refusal. Ready can precede delivery of
 *   the previous completion callback (shared/maintenance_intent.go), so after
 *   proving nothing changed, a new command needs a new key.
 * - 503 'service temporarily unavailable': Fred's generic unavailable answer.
 *   For this key it is either pending work (the backend's lifecycle_pending
 *   answer to not-yet-journaled lifecycle work, or an ambiguous dispatch) or a
 *   replayed terminal/pre-admission refusal. Recovery may still execute a
 *   pending command, so only the same key may follow; a same-key replay is safe
 *   in every case, and the bounded budget rethrows the final 503 unchanged.
 *   Release history can change while it runs.
 */
export async function submitDevnetMaintenance<T>(options: {
  operation: Operation;
  createKey: () => string;
  submit: (key: string) => Promise<T>;
  /** Prove readiness and unchanged release history before another attempt. */
  reconcile: () => Promise<boolean>;
}): Promise<T> {
  let key = options.createKey();
  for (let attempt = 0; ; attempt++) {
    try {
      // The caller invokes the SDK/MCP operation again, minting fresh auth.
      return await options.submit(key);
    } catch (error) {
      const refusal = admissionRefusal(error, options.operation, key);
      // Fred's third callback attempt starts after 1s + 5s plus HTTP work.
      // A final admission attempt after 10s avoids racing that retry at 6s.
      if (refusal === undefined || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      // Fred deduplicates the exact key, which joins any recovery in progress.
      if (refusal === 'pending') continue;
      // Any changed history, non-ready state, or failed read ends recovery.
      if (!(await options.reconcile().catch(() => false))) throw error;
      if (refusal === 'terminal') key = options.createKey();
    }
  }
}

function admissionRefusal(
  error: unknown,
  operation: Operation,
  key: string,
): 'busy' | 'terminal' | 'pending' | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const failure = error as {
    code?: unknown;
    message?: unknown;
    details?: Record<string, unknown>;
  };
  const details = failure.details;
  const status = details?.provider_status;
  // The SDK reports a 4xx as a failed request and a 5xx as an unknown outcome.
  const code =
    status === 409
      ? 'MAINTENANCE_REQUEST_FAILED'
      : status === 503
        ? operation === 'restart'
          ? 'RESTART_INDETERMINATE'
          : 'UPDATE_INDETERMINATE'
        : undefined;
  if (
    code === undefined ||
    failure.code !== code ||
    details?.provider_error_kind !== 'http' ||
    details.idempotency_key !== key ||
    details.operation !== operation ||
    details.outcome !== 'unknown' ||
    typeof failure.message !== 'string'
  )
    return undefined;
  // Match the entire JSON provider body, never a substring of the surrounding
  // recovery guidance. Conflict, transport, and truncated bodies fail closed.
  const marker = failure.message.lastIndexOf(' Cause: ');
  if (marker === -1) return undefined;
  try {
    const body = JSON.parse(failure.message.slice(marker + 8));
    if (body.code !== status) return undefined;
    if (status === 503)
      return body.error === 'service temporarily unavailable'
        ? 'pending'
        : undefined;
    if (body.error === 'lease is already undergoing a lifecycle operation')
      return 'busy';
    if (body.error === `invalid state for ${operation}`) return 'terminal';
  } catch {
    // Not the pinned provider's exact admission response.
  }
  return undefined;
}
