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

interface MaintenanceContext {
  readonly operation: 'restart' | 'update';
  readonly leaseUuid: string;
  readonly idempotencyKey: string;
  readonly outcome: 'unknown' | 'accepted';
  readonly cancelled?: boolean;
}

/** Retain the recovery handle even when waiting fails after command acceptance. */
class MaintenanceError extends ManifestMCPError {
  constructor(
    code: ManifestMCPErrorCode,
    message: string,
    details: Record<string, unknown>,
    readonly cause: unknown,
  ) {
    super(code, message, details);
  }
}

/** Diagnostic formatting must not replace a command's recovery handle. */
function failureText(cause: unknown): string {
  try {
    if (typeof cause === 'string') return cause;
    if (cause instanceof Error) {
      const message: unknown = cause.message;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Custom errors and callbacks may expose throwing message accessors.
  }
  return 'Error details unavailable';
}

function providerSnapshot(
  cause: unknown,
): (ProviderApiErrorOptions & { status: number }) | undefined {
  try {
    if (!ProviderApiError.isProviderApiError(cause)) return undefined;
    const { status, kind, retryAfterMs, details } = cause;
    return {
      status:
        typeof status === 'number' && Number.isFinite(status) ? status : 0,
      kind: typeof kind === 'string' ? kind : undefined,
      retryAfterMs:
        typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
          ? retryAfterMs
          : undefined,
      details: { ...details },
    };
  } catch {
    // Diagnostic metadata is optional; the operation's own identity is not.
    return undefined;
  }
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
  return new ProviderApiError(observed?.status ?? 0, failureText(cause), {
    kind: observed?.kind,
    retryAfterMs: observed?.retryAfterMs,
    cause: operationError,
    details: operationError.details,
  });
}

export function maintenanceError(
  cause: unknown,
  context: MaintenanceContext,
): ManifestMCPError {
  const { operation, leaseUuid, idempotencyKey, outcome } = context;
  const providerError = providerSnapshot(cause);
  const requestFailure =
    outcome === 'unknown' &&
    providerError !== undefined &&
    providerError.status >= 400 &&
    providerError.status < 500;
  const code =
    outcome === 'accepted'
      ? context.cancelled
        ? ManifestMCPErrorCode.OPERATION_CANCELLED
        : ManifestMCPErrorCode.MAINTENANCE_WAIT_FAILED
      : requestFailure
        ? ManifestMCPErrorCode.MAINTENANCE_REQUEST_FAILED
        : operation === 'update'
          ? ManifestMCPErrorCode.UPDATE_INDETERMINATE
          : ManifestMCPErrorCode.RESTART_INDETERMINATE;
  const summary =
    outcome === 'accepted'
      ? `The provider accepted ${operation} for lease ${leaseUuid}, but waiting for readiness ${context.cancelled ? 'was cancelled' : 'failed'}. Check app_status or wait_for_app_ready; cancellation does not revoke the command.`
      : requestFailure
        ? `The provider returned HTTP ${providerError.status} for ${operation} on lease ${leaseUuid}. Reconcile the response with app_status and app_releases before submitting a new command.`
        : `The ${operation} outcome for lease ${leaseUuid} is unknown: it may or may not have been applied, and the provider may retain a pending command that executes later. Check app_status and app_releases; do not close the lease to recover from this error.`;
  const guidance =
    ` Command idempotency_key: ${idempotencyKey}. For an exact retry, reuse this key` +
    (operation === 'update' ? ' and the exact same manifest payload' : '') +
    '; mint a fresh authentication token for each HTTP attempt. A new key starts a new command and can conflict with pending work.';
  const detail = capProviderText(
    failureText(cause),
    PROVIDER_TEXT_EXCERPT_CHARS,
  );
  return new MaintenanceError(
    code,
    `${summary}${guidance} Cause: ${detail}`,
    {
      ...providerError?.details,
      lease_uuid: leaseUuid,
      idempotency_key: idempotencyKey,
      operation,
      outcome,
      ...(providerError && {
        status: providerError.status,
        provider_status: providerError.status,
        ...(providerError.kind && { provider_error_kind: providerError.kind }),
        ...(providerError.retryAfterMs !== undefined && {
          retry_after_ms: providerError.retryAfterMs,
        }),
      }),
    },
    cause,
  );
}
