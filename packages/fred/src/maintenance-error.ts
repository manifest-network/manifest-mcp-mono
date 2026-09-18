import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  capProviderText,
  PROVIDER_TEXT_EXCERPT_CHARS,
  ProviderApiError,
  type ProviderApiErrorOptions,
} from './http/provider.js';

interface MaintenanceCommand {
  readonly operation: 'restart' | 'update';
  readonly leaseUuid: string;
  readonly idempotencyKey: string;
}

interface MaintenanceContext extends MaintenanceCommand {
  readonly outcome: 'unknown' | 'accepted';
}

/** Diagnostic formatting must not replace a command's recovery handle. */
function property(value: unknown, key: string): unknown {
  try {
    if (typeof value === 'object' && value !== null)
      return (value as Record<string, unknown>)[key];
  } catch {
    // Custom errors and callbacks may expose throwing diagnostic accessors.
  }
  return undefined;
}

function failureText(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  const message = property(cause, 'message');
  return typeof message === 'string' ? message : 'Error details unavailable';
}

function errorDetails(cause: unknown): Record<string, unknown> {
  try {
    const details = property(cause, 'details');
    return typeof details === 'object' && details !== null
      ? { ...details }
      : {};
  } catch {
    return {};
  }
}

function manifestCode(
  cause: unknown,
  allowForeign = false,
): ManifestMCPErrorCode | undefined {
  try {
    if (
      !(cause instanceof ManifestMCPError) &&
      (!allowForeign || property(cause, 'name') !== 'ManifestMCPError')
    )
      return undefined;
    const code = property(cause, 'code');
    return Object.values(ManifestMCPErrorCode).includes(
      code as ManifestMCPErrorCode,
    )
      ? (code as ManifestMCPErrorCode)
      : undefined;
  } catch {
    // Even instanceof can invoke user code through a proxy's getPrototypeOf.
    return undefined;
  }
}

function timeoutError(cause: unknown): Error {
  try {
    if (typeof DOMException !== 'undefined' && cause instanceof DOMException)
      return new DOMException(failureText(cause), 'TimeoutError');
  } catch {
    // A non-native timeout reason can still retain its name and recovery context.
  }
  return Object.assign(new Error(failureText(cause)), { name: 'TimeoutError' });
}

function providerSnapshot(
  cause: unknown,
):
  | (ProviderApiErrorOptions & { status: number; error: ProviderApiError })
  | undefined {
  try {
    if (!ProviderApiError.isProviderApiError(cause)) return undefined;
    const status = property(cause, 'status');
    const kind = property(cause, 'kind');
    const retryAfterMs = property(cause, 'retryAfterMs');
    return {
      error: cause,
      status:
        typeof status === 'number' && Number.isFinite(status) ? status : 0,
      kind:
        typeof kind === 'string'
          ? (kind as ProviderApiErrorOptions['kind'])
          : undefined,
      retryAfterMs:
        typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
          ? retryAfterMs
          : undefined,
      details: errorDetails(cause),
    };
  } catch {
    return undefined;
  }
}

function commandDetails(
  cause: unknown,
  context: MaintenanceContext,
): Record<string, unknown> {
  const observed = providerSnapshot(cause);
  return {
    ...errorDetails(cause),
    lease_uuid: context.leaseUuid,
    idempotency_key: context.idempotencyKey,
    operation: context.operation,
    outcome: context.outcome,
    // An uncertain POST failure alone is not evidence of submission. Accepted
    // commands are known to have reached Fred even if the readiness wait fails.
    ...(context.outcome === 'accepted' && { sent: true }),
    ...(observed && {
      // Zero is ProviderApiError's local-error sentinel, never an HTTP status.
      ...(observed.status >= 100 &&
        observed.status <= 599 && {
          provider_status: observed.status,
        }),
      ...(observed.kind && { provider_error_kind: observed.kind }),
      ...(observed.retryAfterMs !== undefined && {
        retry_after_ms: observed.retryAfterMs,
      }),
    }),
  };
}

function retainCauseAndStack<T extends Error>(error: T, cause: unknown): T {
  Object.defineProperty(error, 'cause', {
    value: cause,
    configurable: true,
    enumerable: false,
  });
  const stack = property(cause, 'stack');
  if (typeof stack === 'string') error.stack = stack;
  return error;
}

function typedError(
  code: ManifestMCPErrorCode,
  message: string,
  details: Record<string, unknown>,
  cause: unknown,
): ManifestMCPError {
  return retainCauseAndStack(
    new ManifestMCPError(code, message, details),
    cause,
  );
}

/** Keep the low-level ProviderApiError API while vetoing automatic command replay. */
export function maintenanceRequestError(
  cause: unknown,
  leaseUuid: string,
  idempotencyKey: string,
  operation: 'restart' | 'update',
): ProviderApiError {
  const observed = providerSnapshot(cause);
  const operationError = maintenanceError(cause, {
    leaseUuid,
    idempotencyKey,
    operation,
    outcome: 'unknown',
  });
  const enriched = new ProviderApiError(
    observed?.status ?? 0,
    failureText(cause),
    {
      kind: observed?.kind,
      retryAfterMs: observed?.retryAfterMs,
      details: operationError.details,
    },
  );
  return retainCauseAndStack(enriched, operationError);
}

/** POST errors describe the logical command, including any earlier exact-key attempt. */
export function maintenanceError(
  cause: unknown,
  context: MaintenanceContext,
): ManifestMCPError {
  const { operation, leaseUuid, idempotencyKey } = context;
  // Raw helpers already minted this typed diagnostic. Expose it directly rather
  // than wrapping the same request for a third time at the high-level boundary.
  // Only inspect that cause after its outer command context establishes ownership;
  // an original transport/body failure's diagnostic cause cannot be reused.
  const outerDetails = errorDetails(cause);
  const prior =
    outerDetails.lease_uuid === leaseUuid &&
    outerDetails.idempotency_key === idempotencyKey &&
    outerDetails.operation === operation &&
    outerDetails.outcome === context.outcome
      ? property(cause, 'cause')
      : undefined;
  const priorDetails = errorDetails(prior);
  const priorCode = manifestCode(prior);
  if (
    (priorCode === ManifestMCPErrorCode.MAINTENANCE_REQUEST_FAILED ||
      priorCode === ManifestMCPErrorCode.UPDATE_INDETERMINATE ||
      priorCode === ManifestMCPErrorCode.RESTART_INDETERMINATE) &&
    priorDetails.lease_uuid === leaseUuid &&
    priorDetails.idempotency_key === idempotencyKey &&
    priorDetails.operation === operation &&
    priorDetails.outcome === context.outcome
  )
    return prior as ManifestMCPError;

  const observed = providerSnapshot(cause);
  const requestFailure =
    observed !== undefined && observed.status >= 400 && observed.status < 500;
  const code = requestFailure
    ? ManifestMCPErrorCode.MAINTENANCE_REQUEST_FAILED
    : operation === 'update'
      ? ManifestMCPErrorCode.UPDATE_INDETERMINATE
      : ManifestMCPErrorCode.RESTART_INDETERMINATE;
  const summary = requestFailure
    ? `The provider returned HTTP ${observed.status} for ${operation} on lease ${leaseUuid}. This response does not establish the outcome of an earlier attempt with the same command key. Reconcile app_status and app_releases before submitting a new command.`
    : `The ${operation} outcome for lease ${leaseUuid} is unknown: it may or may not have been applied, and the provider may retain a pending command that executes later. Check app_status and app_releases; do not close the lease to recover from this error.`;
  const guidance =
    (observed?.status === 401
      ? ' Refresh provider authentication before an exact retry.'
      : '') +
    ` Command idempotency_key: ${idempotencyKey}. For an exact retry, reuse this key` +
    (operation === 'update' ? ' and the exact same manifest payload' : '') +
    '; mint a fresh authentication token for each HTTP attempt. A new key starts a new command and can conflict with pending work.';
  return typedError(
    code,
    `${summary}${guidance} Cause: ${capProviderText(failureText(cause), PROVIDER_TEXT_EXCERPT_CHARS)}`,
    commandDetails(cause, context),
    cause,
  );
}

/** Enrich a failed wait without replacing the readiness or operational verdict. */
export function maintenanceWaitError(
  cause: unknown,
  context: MaintenanceCommand & {
    readonly signal?: AbortSignal;
    readonly callerSignals: ReadonlyArray<AbortSignal | undefined>;
  },
): Error {
  const interrupted =
    context.signal?.aborted && Object.is(cause, context.signal.reason);
  const deadline = interrupted && property(cause, 'name') === 'TimeoutError';
  const details = {
    readiness: 'unconfirmed',
    ...commandDetails(cause, { ...context, outcome: 'accepted' }),
    ...(deadline && { reason: 'deadline' }),
  };
  const cancelled =
    interrupted &&
    !deadline &&
    context.callerSignals.some(
      (signal) => signal?.aborted && Object.is(cause, signal.reason),
    );
  if (cancelled) {
    return typedError(
      ManifestMCPErrorCode.OPERATION_CANCELLED,
      `The provider accepted ${context.operation} for lease ${context.leaseUuid}, but waiting for readiness was cancelled. Cancellation does not revoke the command; check app_status or wait_for_app_ready. Cause: ${failureText(cause)}`,
      details,
      cause,
    );
  }

  // Rebuild foreign-core operational errors locally so typed SDK/MCP consumers
  // retain their code. Raw POST reuse above still requires a local instance.
  const operationalCode = manifestCode(cause, true);
  if (operationalCode !== undefined) {
    return typedError(operationalCode, failureText(cause), details, cause);
  }

  const marker = typedError(
    ManifestMCPErrorCode.MAINTENANCE_WAIT_FAILED,
    capProviderText(failureText(cause)),
    details,
    cause,
  );
  const observed = providerSnapshot(cause);
  if (observed) {
    try {
      // The public readiness subclasses override withContext, retaining their
      // reason/state/timing fields and instanceof contract. Their context type
      // predates maintenance, so merge the full details on the new instance too.
      const enriched = observed.error.withContext({
        providerUuid: observed.details?.provider_uuid,
        providerUrl: observed.details?.provider_url,
        ...details,
      });
      Object.defineProperty(enriched, 'details', {
        value: details,
        configurable: true,
        enumerable: true,
      });
      return retainCauseAndStack(enriched, marker);
    } catch {
      // A custom branded error may have unreadable diagnostics or enrichment.
      // The typed fallback still carries the accepted command's recovery handle.
      return marker;
    }
  }

  if (deadline) {
    const enriched = timeoutError(cause);
    Object.defineProperty(enriched, 'details', {
      value: details,
      configurable: true,
      enumerable: true,
    });
    return retainCauseAndStack(enriched, marker);
  }
  return marker;
}
