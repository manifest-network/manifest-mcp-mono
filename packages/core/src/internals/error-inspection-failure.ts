// Normalizing diagnostics cannot grant a retry that inspection of the original
// error did not authorize. Provenance stays private and cannot be forged in details.
const failures = new WeakSet<Error>();

export function markErrorInspectionFailure(error: Error): void {
  failures.add(error);
}

export function isErrorInspectionFailure(error: Error): boolean {
  return failures.has(error);
}
