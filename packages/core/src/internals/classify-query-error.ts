import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';

/** gRPC status code for NOT_FOUND. grpc-gateway maps it to HTTP 404 — but NOT vice versa. */
const GRPC_NOT_FOUND = 5;

/**
 * cosmjs surfaces a gRPC NotFound only as message text over RPC — no structured
 * code exists on that transport. Character-identical to cosmjs's own probe in
 * StargateClient.getAccount. Do NOT widen: `/not.?found/i` matches a PROXY 404
 * ("Endpoint not found"), which is a real failure, not an absence.
 */
const RPC_NOT_FOUND_RE = /rpc error: code = NotFound/i;

/**
 * @public — structured transport detail carried by query errors. Fields are absent
 * when the transport cannot supply them (RPC has no HTTP layer; a proxy 404 has no
 * grpc envelope).
 */
export interface QueryErrorDetails {
  readonly httpStatus?: number;
  readonly grpcCode?: number;
  readonly grpcMessage?: string;
}

/** Duck-typed `err.response`. No axios import: core is platform-neutral and axios is transitive. */
function readResponse(
  err: unknown,
): { status?: unknown; data?: unknown } | undefined {
  if (typeof err !== 'object' || err === null || !('response' in err))
    return undefined;
  const resp = (err as { response?: unknown }).response;
  if (typeof resp !== 'object' || resp === null) return undefined;
  return resp as { status?: unknown; data?: unknown };
}

function readDetails(err: unknown): QueryErrorDetails {
  const resp = readResponse(err);
  const data = resp?.data;
  const body =
    typeof data === 'object' && data !== null
      ? (data as { code?: unknown; message?: unknown })
      : undefined;
  // A body is a grpc envelope ONLY when `code` is a NUMBER. That single test is
  // what separates a keeper NotFound from a proxy's {"error":"not_found"} — and
  // BOTH fields must be gated on it. The proxy body also has a `message`
  // ("Endpoint not found"), so gating grpcMessage separately would publish proxy
  // text on a @public field documented as keeper text.
  const isEnvelope = typeof body?.code === 'number';
  return {
    httpStatus: typeof resp?.status === 'number' ? resp.status : undefined,
    grpcCode: isEnvelope ? (body?.code as number) : undefined,
    grpcMessage:
      isEnvelope && typeof body?.message === 'string'
        ? body.message
        : undefined,
  };
}

/**
 * @public — true when `err` means "the chain answered: no such entity".
 *
 * Accepts the three shapes a Manifest read can produce:
 *  1. our own `ManifestMCPError` (structured `code`);
 *  2. a RAW LCD error from a caller's own manifestjs client (grpc envelope) —
 *     deliberate: manifestjs owns transport, we own the semantic (spec Decision 4);
 *  3. a plain RPC `Error` (message text only — RPC offers nothing better).
 *
 * Deliberately NOT keyed on HTTP 404: a proxy/route 404 carries no envelope and
 * must not read as "absent".
 *
 * NO `instanceof` (ENG-462): `ManifestMCPError` carries no brand, so `instanceof`
 * is false across duplicate package copies — which would silently reproduce the
 * exact pre-ENG-536 symptom. Value-check `.code` like `isSkuAmbiguousError` does
 * (cosmjs `isDeliverTxFailure` idiom). Safe against the AxiosError `.code`
 * landmine: axios's own codes are 'ERR_BAD_REQUEST'/'ERR_NETWORK', never 'NOT_FOUND'.
 */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    if ((err as { code?: unknown }).code === ManifestMCPErrorCode.NOT_FOUND)
      return true;
    const grpcCode = readDetails(err).grpcCode;
    if (grpcCode !== undefined) return grpcCode === GRPC_NOT_FOUND;
  }
  if (err instanceof Error) return RPC_NOT_FOUND_RE.test(err.message);
  return false;
}

/**
 * Turn a raw LCD (axios) rejection into a structured `ManifestMCPError`.
 *
 * `NOT_FOUND` only when the grpc envelope says `code: 5`; everything else stays
 * `QUERY_FAILED`. `details` is attached to BOTH so `retry.ts` can branch on
 * `httpStatus` instead of regexing axios's message template.
 */
export function classifyLcdError(
  key: string,
  error: unknown,
): ManifestMCPError {
  const details = readDetails(error);
  const raw = error instanceof Error ? error.message : String(error);

  if (details.grpcCode === GRPC_NOT_FOUND) {
    return new ManifestMCPError(
      ManifestMCPErrorCode.NOT_FOUND,
      `LCD query "${key}" not found: ${details.grpcMessage ?? raw}`,
      { ...details },
    );
  }
  return new ManifestMCPError(
    ManifestMCPErrorCode.QUERY_FAILED,
    `LCD query "${key}" failed: ${raw}`,
    {
      ...details,
    },
  );
}
