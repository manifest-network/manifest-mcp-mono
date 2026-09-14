import { ManifestMCPError } from '../types.js';
import { isOwnedBroadcastFailure } from './broadcast-failure.js';

/** Add operation context while retaining an owned post-submission failure's cause chain. */
export function attributeBroadcastFailure(
  error: unknown,
  messagePrefix: string,
  details: Record<string, unknown>,
): ManifestMCPError | null {
  if (!isOwnedBroadcastFailure(error)) return null;
  return Object.defineProperty(
    new ManifestMCPError(error.code, `${messagePrefix}${error.message}`, {
      ...error.details,
      ...details,
    }),
    'cause',
    { value: error, configurable: true, writable: true },
  );
}
