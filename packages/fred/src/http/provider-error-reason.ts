import { ProviderApiError } from './provider.js';

/**
 * Fred's tenant error body is `{"error": string, "code": number, "reason"?: string}`.
 * `reason` is a snake_case code Fred attaches to a definitive answer, such as
 * `maintenance_expired`, `backend_storage_lost` or `maintenance_capacity_reserved`.
 * Like the provision failure `reason`, the set is open and add-only: callers branch
 * only on values they know, and an unknown one is reported as-is.
 *
 * Bounded and identifier-shaped, so the provider-controlled value is safe to
 * carry in error details.
 */
const PROVIDER_ERROR_REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** Fred's refusal of a keyless restart/update since PR #240 (`internal/api/handlers.go`). */
const IDEMPOTENCY_KEY_REQUIRED =
  'Idempotency-Key header must occur exactly once';

/**
 * Fred's refusal of a billing-only lease's payload since PR #268 (`internal/api/payload.go`),
 * which released Fred v0.13.1 and v0.13.2 send without a `reason`.
 */
const BILLING_ONLY_PAYLOAD_REFUSED =
  'lease is billing-only and does not accept a payload';

/** The `reason` Fred v0.14 attaches to its billing-only refusals (PR #276). */
const BILLING_ONLY_REASON = 'billing_only';

interface FredErrorBody {
  readonly status: number;
  readonly error?: string;
  readonly reason?: string;
}

/**
 * Fred's JSON error body from an HTTP `ProviderApiError`, or `undefined` when the
 * error is not an HTTP answer or its body is not Fred's error shape. The body's
 * `code` must equal the response status, so an intermediary's unrelated JSON or a
 * truncated body never qualifies.
 */
function fredErrorBody(error: unknown): FredErrorBody | undefined {
  try {
    if (!ProviderApiError.isProviderApiError(error)) return undefined;
    const { status, kind, message } = error;
    if (
      kind !== 'http' ||
      typeof status !== 'number' ||
      status < 400 ||
      status > 599 ||
      typeof message !== 'string'
    )
      return undefined;
    const body: unknown = JSON.parse(message);
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return undefined;
    const { code, error: text, reason } = body as Record<string, unknown>;
    if (code !== status) return undefined;
    return {
      status,
      ...(typeof text === 'string' && { error: text }),
      ...(typeof reason === 'string' &&
        PROVIDER_ERROR_REASON.test(reason) && { reason }),
    };
  } catch {
    // Unparseable bodies and throwing diagnostic accessors carry no reason.
    return undefined;
  }
}

/** The `reason` code from Fred's error body, when one is present. */
export function providerErrorReason(error: unknown): string | undefined {
  return fredErrorBody(error)?.reason;
}

/**
 * True for Fred's `410 backend_storage_lost`: an operator retired the lease's
 * backend because its storage was irrecoverably lost (Fred PR #243). The lease's
 * workload and data are gone, so no retry or restore can succeed.
 */
export function isBackendStorageLost(error: unknown): boolean {
  const body = fredErrorBody(error);
  return body?.status === 410 && body.reason === 'backend_storage_lost';
}

/**
 * True when a PR #240 or newer provider refused a restart/update because the
 * request omitted `Idempotency-Key`. Fred refuses it before recording the
 * command, so the command did not run.
 */
export function isIdempotencyKeyRequired(error: unknown): boolean {
  const body = fredErrorBody(error);
  return body?.status === 400 && body.error === IDEMPOTENCY_KEY_REQUIRED;
}

/**
 * True when the provider refused a payload upload because every SKU of the
 * lease is billing-only there (Fred PR #268): it bills the lease but delivers
 * the service outside Fred, so it never deploys a manifest to it. Fred
 * acknowledges such a lease as soon as it sees it, which starts its billing.
 *
 * Fred v0.14 marks the refusal with `reason: billing_only` (PR #276), and
 * refuses as billing-only in any lease state, so an upload that finds the
 * lease already ACTIVE gets this answer instead of `404 lease not pending`.
 * v0.13.1 and v0.13.2 send the same text without a reason, so the exact text
 * is still accepted. Fred sends the same reason when it refuses a restore into
 * such a lease, so pass only a payload upload's answer.
 */
export function isBillingOnlyPayloadRefusal(error: unknown): boolean {
  const body = fredErrorBody(error);
  return (
    body?.status === 400 &&
    (body.reason === BILLING_ONLY_REASON ||
      body.error === BILLING_ONLY_PAYLOAD_REFUSED)
  );
}
