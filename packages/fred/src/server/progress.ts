import { logger } from '@manifest-network/manifest-mcp-core';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Builds a fire-and-forget progress emitter for a long-running tool.
 * Returns `undefined` if the caller didn't request progress (no
 * `progressToken` in `extra._meta`); callers can branch on that to skip
 * notification work entirely.
 *
 * Notifications are best-effort: failures are logged but don't fail the
 * tool. Each call increments the progress counter.
 */
export function createProgressEmitter(
  toolName: string,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ((message: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  let counter = 0;
  return (message: string) => {
    counter += 1;
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: counter,
          message,
        },
      })
      .catch((err: unknown) => {
        logger.warn(
          `[${toolName}] progress notification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };
}
