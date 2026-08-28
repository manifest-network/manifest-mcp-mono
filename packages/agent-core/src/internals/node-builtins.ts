/**
 * Resolve a Node builtin without leaving a bundler-visible import edge.
 *
 * `process.getBuiltinModule` is available throughout this package's supported
 * Node range. Browser runtimes either have no `process` or expose a shim without
 * this method, in which case callers retain their own domain-specific error.
 */
export function getNodeBuiltin<T extends object>(
  specifier: string,
): T | undefined {
  if (
    typeof process === 'undefined' ||
    typeof process.versions?.node !== 'string' ||
    typeof process.getBuiltinModule !== 'function'
  ) {
    return undefined;
  }
  return process.getBuiltinModule(specifier) as T | undefined;
}
