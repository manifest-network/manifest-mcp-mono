/**
 * Remove every trailing `/` from a URL string in linear time.
 *
 * Replaces `value.replace(/\/+$/, '')`, which backtracks quadratically on a long interior slash
 * run (CodeQL js/polynomial-redos). Fred keeps its own copy in `src/trailing-slashes.ts` so this
 * helper stays off core's public surface.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
}
