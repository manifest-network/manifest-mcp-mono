/**
 * Fred's exact tenant error bodies (`internal/api/handlers.go` at the pinned
 * submodule, Fred PRs #240, #242 and #243). Go's JSON encoder appends the
 * trailing newline. Each is served as a probe step so the real transport builds
 * the `ProviderApiError` the client parses.
 */
function fredError(status: number, body: string) {
  return {
    status,
    text: `${body}\n`,
    headers: { 'content-type': 'application/json' },
  } as const;
}

/** A keyless restart/update refused by a PR #240 or newer provider. */
export const KEY_REQUIRED = fredError(
  400,
  '{"error":"Idempotency-Key header must occur exactly once","code":400}',
);

/** A command settled without running because a newer one superseded it. */
export const MAINTENANCE_EXPIRED = fredError(
  410,
  '{"error":"this command is older than the lease\'s retained maintenance history and was not run; send a new command","code":410,"reason":"maintenance_expired"}',
);

/** A lease whose backend an operator retired as irrecoverably lost. */
export const BACKEND_STORAGE_LOST = fredError(
  410,
  '{"error":"the backend storage holding this lease was irrecoverably lost","code":410,"reason":"backend_storage_lost"}',
);

/** The shared maintenance reserve, refused before Fred records the command. */
export const CAPACITY_RESERVED = {
  ...fredError(
    429,
    '{"error":"maintenance capacity is reserved for tenants without pending work; retry after your pending work completes","code":429,"reason":"maintenance_capacity_reserved"}',
  ),
  headers: { 'content-type': 'application/json', 'retry-after': '1' },
} as const;
