// Failed diagnostic inspection (including malformed SDK codes) cannot authorize
// replay, even through an enclosing transient error. An ordinary readable error
// with no transient signals is not an inspection failure. Provenance stays private
// and cannot be forged in details.
const failures = new WeakSet<Error>();

export function markErrorInspectionFailure(error: Error): void {
  failures.add(error);
}

export function isErrorInspectionFailure(error: Error): boolean {
  return failures.has(error);
}
