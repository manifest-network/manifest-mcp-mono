import {
  ManifestMCPError,
  type ManifestMCPErrorCode,
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
  try {
    if (error instanceof ManifestMCPError) {
      const originalCode = error.code;
      if (typeof originalCode === 'string') code = originalCode;
    }
  } catch {
    // The supplied fallback remains authoritative when attribution is unreadable.
  }
  return Object.defineProperty(
    new ManifestMCPError(code, `${prefix}${diagnosticMessage(error)}`),
    'cause',
    { value: error, configurable: true, writable: true },
  );
}
