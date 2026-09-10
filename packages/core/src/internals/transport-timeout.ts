import { ManifestMCPError } from '../types.js';
import { errorChain } from './error-chain.js';

/**
 * Match an abort from a transport's own per-attempt deadline, including fetch wrappers.
 * The caller must own this signal; a caller/whole-operation signal cannot authorize retry.
 */
export function isTransportTimeout(
  error: unknown,
  deadline: AbortSignal,
): boolean {
  if (!deadline.aborted) return false;
  const chain = error instanceof Error ? errorChain(error) : [];
  // An established SDK verdict wins even if a transport ignored the abort signal.
  if (chain.some((entry) => entry instanceof ManifestMCPError)) return false;
  return (
    error === deadline.reason ||
    chain.some(
      (entry) =>
        entry === deadline.reason ||
        entry.name === 'AbortError' ||
        entry.name === 'TimeoutError',
    )
  );
}
