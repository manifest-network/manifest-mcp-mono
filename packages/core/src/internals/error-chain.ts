/** Inspect standard error causes without looping on a malformed cyclic chain. */
export function errorChain(error: Error): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return chain;
}
