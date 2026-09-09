import { parseLeaseUuid } from '@manifest-network/manifest-mcp-core';

/** Reuse core's UUID grammar while callers retain their own error codes and context. */
export function isLeaseUuidShape(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseLeaseUuid(value);
    return true;
  } catch {
    return false;
  }
}
