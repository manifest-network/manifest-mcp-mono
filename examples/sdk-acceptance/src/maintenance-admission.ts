type Operation = 'restart' | 'update';

/**
 * Devnet harness only, tied to Fred 4f00091c. Ready can precede delivery of the
 * previous completion callback (shared/maintenance_intent.go). The provider
 * journals backend InvalidState as a terminal refusal, so that exact refusal
 * needs a new command key; provider claim-busy happens before command admission
 * and can retry the original key (placement/maintenance_application.go).
 * Never use this policy for an unknown provider or an earlier uncertain attempt.
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
): 'busy' | 'terminal' | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const failure = error as {
    code?: unknown;
    message?: unknown;
    details?: Record<string, unknown>;
  };
  const details = failure.details;
  if (
    failure.code !== 'MAINTENANCE_REQUEST_FAILED' ||
    details?.provider_status !== 409 ||
    details.provider_error_kind !== 'http' ||
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
    if (body.code !== 409) return undefined;
    if (body.error === 'lease is already undergoing a lifecycle operation')
      return 'busy';
    if (body.error === `invalid state for ${operation}`) return 'terminal';
  } catch {
    // Not the pinned provider's definitive admission response.
  }
  return undefined;
}
