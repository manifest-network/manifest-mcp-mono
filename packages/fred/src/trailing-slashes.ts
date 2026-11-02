/**
 * Remove every trailing `/` from a URL string in linear time.
 *
 * Replaces `value.replace(/\/+$/, '')`, which backtracks quadratically on a long interior slash
 * run (CodeQL js/polynomial-redos). Provider URLs come from on-chain records, so the input is
 * not trusted. Core keeps its own copy in `internals/trailing-slashes.ts`, off its public surface.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
}
