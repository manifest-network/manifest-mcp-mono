/** Diagnostic formatting must not replace an operation's recovery information. */
export function errorMessageOf(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'Error message unavailable';
  }
}

/** Read independent diagnostic fields without discarding previously established facts. */
export function readDiagnostic<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
