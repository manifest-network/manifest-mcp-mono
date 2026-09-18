/** Inspect causes without cycles; optionally stop before reading a verdict's cause. */
export function errorChain(
  error: Error,
  stopAt?: (error: Error) => boolean,
): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    if (stopAt?.(current)) break;
    current = 'cause' in current ? current.cause : undefined;
  }
  return chain;
}
