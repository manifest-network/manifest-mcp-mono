import {
  isRetryableError,
  ManifestMCPError,
  type ManifestMCPErrorCode,
  sanitizeForLogging,
} from '@manifest-network/manifest-mcp-core';

/** Read one diagnostic without letting injected accessors replace the outcome. */
export function diagnosticField(value: unknown, key: string): unknown {
  try {
    return value !== null && typeof value === 'object'
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}

export function diagnosticMessage(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Error message unavailable';
  }
}

/** Preserve readable SDK codes while always producing a readable diagnostic. */
export function contextualError(
  error: unknown,
  fallbackCode: ManifestMCPErrorCode,
  prefix: string,
): ManifestMCPError {
  let code = fallbackCode;
  let unreadable = false;
  try {
    if (error instanceof ManifestMCPError) {
      const originalCode = error.code;
      if (typeof originalCode === 'string') code = originalCode;
    }
  } catch {
    // The supplied fallback remains authoritative when attribution is unreadable.
    unreadable = true;
  }
  let message: string;
  try {
    const rawMessage = error instanceof Error ? error.message : error;
    if (typeof rawMessage !== 'string') unreadable = true;
    message = String(rawMessage);
  } catch {
    unreadable = true;
    message = 'Error message unavailable';
  }
  // Diagnostic coercion can introduce transient text, and an inspection
  // failure's cause can still look transient. Keep the caller's fallback
  // verdict authoritative (TX_FAILED at paid recovery boundaries).
  const contextual = new ManifestMCPError(
    unreadable ? fallbackCode : code,
    `${prefix}${sanitizeForLogging(message) as string}`,
  );
  // Preserve an existing retry veto when attribution would discard it (for
  // example a core normalization marker, cancellation name or permanent status).
  // Otherwise keep historical cause omission: copying a transient cause can
  // authorize replay of an operation whose contextual wrapper is terminal.
  const losesRetryVeto =
    !unreadable && isRetryableError(contextual) && !isRetryableError(error);
  return unreadable || losesRetryVeto
    ? Object.defineProperty(contextual, 'cause', {
        value: error,
        configurable: true,
        writable: true,
      })
    : contextual;
}
