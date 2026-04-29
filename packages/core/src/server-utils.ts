import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createValidatedConfig } from './config.js';
import { logger } from './logger.js';
import {
  type ManifestMCPConfig,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type WalletProvider,
} from './types.js';
import { MnemonicWalletProvider } from './wallet/index.js';

/**
 * Error codes that indicate infrastructure-level failures (wallet, RPC, config).
 * Used by tool implementations to distinguish infrastructure errors from
 * provider/application errors so that infrastructure errors are always re-thrown.
 */
export const INFRASTRUCTURE_ERROR_CODES: ReadonlySet<ManifestMCPErrorCode> =
  new Set([
    ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
    ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
    ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
    ManifestMCPErrorCode.INVALID_MNEMONIC,
    ManifestMCPErrorCode.INVALID_CONFIG,
  ]);

/**
 * Sensitive field names that should be redacted from error responses
 */
export const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'mnemonic',
  'privatekey',
  'private_key',
  'secret',
  'password',
  'seed',
  'secret_key',
  'signing_key',
  'apikey',
  'api_key',
  'auth_token',
  'bearer_token',
  'access_token',
  'refresh_token',
]);

// Note: standalone "key" and "token" are intentionally excluded from SENSITIVE_FIELDS
// because they are too generic — they would match pagination keys, map keys, and
// non-sensitive token identifiers. Use compound names (api_key, auth_token, etc.) instead.

/**
 * JSON replacer that converts BigInt values to strings
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Recursively sanitize an object by redacting sensitive fields
 */
export function sanitizeForLogging(obj: unknown, depth = 0): unknown {
  // Prevent infinite recursion
  if (depth > 10) {
    return '[max depth exceeded]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Redact strings that look like BIP-39 mnemonics (12/15/18/21/24 words).
    // BIP-39 words are all lowercase alphabetic, so require that to avoid
    // false positives on error messages that happen to be 12/24 words.
    const words = obj.trim().split(/\s+/);
    const wordCount = words.length;
    if (wordCount >= 12 && wordCount <= 24 && wordCount % 3 === 0) {
      const allLowercaseAlpha = words.every((w) => /^[a-z]+$/.test(w));
      if (allLowercaseAlpha) {
        return '[REDACTED - possible mnemonic]';
      }
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeForLogging(item, depth + 1));
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.has(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeForLogging(value, depth + 1);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Options for creating a chain, lease, or fred MCP server
 */
export interface ManifestMCPServerOptions {
  config: ManifestMCPConfig;
  walletProvider: WalletProvider;
}

/**
 * Wrap a tool handler with error handling that preserves the existing error format.
 *
 * Generic over the callback type so that Zod-inferred argument types from
 * McpServer.registerTool flow through without requiring manual casts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- preserves ToolCallback<Args> signature from McpServer
export function withErrorHandling<
  T extends (...args: any[]) => Promise<CallToolResult>,
>(toolName: string, fn: T): T {
  // For tools with no inputSchema, McpServer calls cb(extra) with one arg.
  // For tools with inputSchema, McpServer calls cb(parsedArgs, extra).
  // We infer from cbArgs.length at call time (not fn.length) so default parameters are safe.
  const wrapped = async (...cbArgs: any[]) => {
    const hasArgs = cbArgs.length >= 2;
    const args = hasArgs ? (cbArgs[0] ?? {}) : {};
    try {
      return hasArgs ? await fn(args, cbArgs[1]) : await fn(cbArgs[0]);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof ManifestMCPError ? error.code : 'UNKNOWN';
      if (error instanceof ManifestMCPError) {
        logger.error(
          `[${toolName}] Tool error [${errorCode}]: ${errorMessage}`,
        );
      } else {
        const stack =
          error instanceof Error && error.stack ? `\n${error.stack}` : '';
        logger.error(
          `[${toolName}] Tool error [${errorCode}]: ${errorMessage}${stack}`,
        );
      }

      // Sanitize error messages before including in the MCP response.
      // This catches mnemonic-like strings in error messages and redacts them.
      const safeMessage = sanitizeForLogging(errorMessage) as string;

      let errorResponse: Record<string, unknown> = {
        error: true,
        tool: toolName,
        input: sanitizeForLogging(args),
      };

      if (error instanceof ManifestMCPError) {
        errorResponse = {
          ...errorResponse,
          code: error.code,
          message: sanitizeForLogging(error.message) as string,
          details: sanitizeForLogging(error.details),
        };
      } else {
        errorResponse = {
          ...errorResponse,
          message: safeMessage,
        };
      }

      let responseText: string;
      try {
        responseText = JSON.stringify(errorResponse, bigIntReplacer, 2);
      } catch (stringifyError) {
        logger.error(
          `[${toolName}] Failed to serialize error response: ${stringifyError instanceof Error ? stringifyError.message : String(stringifyError)}`,
        );
        responseText = JSON.stringify({
          error: true,
          tool: toolName,
          message: safeMessage,
        });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: responseText,
          },
        ],
        isError: true,
      };
    }
  };
  return wrapped as T;
}

/**
 * Helper to build a successful JSON text response
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches JSON.stringify's replacer signature
export function jsonResponse(
  data: unknown,
  replacer?: (key: string, value: any) => any,
): CallToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, replacer, 2),
      },
    ],
  };
}

/**
 * Helper to build a successful CallToolResult with both `structuredContent`
 * (consumed by clients that validate against the tool's outputSchema) and
 * `content` (text fallback for clients that don't). Use this for any tool
 * registered with an `outputSchema`. Per MCP spec, `structuredContent` must
 * be a JSON object — `data` is therefore typed as a record.
 *
 * The optional `replacer` is applied to BOTH `structuredContent` and the
 * text fallback by round-tripping through JSON. This keeps `structuredContent`
 * JSON-serializable for the wire, even if the caller hands us a `BigInt`,
 * `Date`, or anything else `JSON.stringify` knows how to convert via the
 * replacer.
 */
export function structuredResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches JSON.stringify's replacer signature
  data: Record<string, unknown>,
  replacer?: (key: string, value: any) => any,
): CallToolResult {
  const serialized = JSON.stringify(data, replacer);
  const structuredContent = JSON.parse(serialized) as Record<string, unknown>;
  return {
    structuredContent,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, undefined, 2),
      },
    ],
  };
}

/**
 * Config shape accepted by createMnemonicServer.
 * Derives from ManifestMCPConfig (minus rateLimit/retry) so new config fields propagate automatically.
 */
export type MnemonicServerConfig = Omit<
  ManifestMCPConfig,
  'rateLimit' | 'retry'
> & {
  readonly mnemonic: string;
};

/**
 * Generic factory that creates any MCP server class with a mnemonic wallet.
 *
 * Eliminates duplicated createMnemonic*Server patterns -- callers pass the
 * server constructor instead.
 */
export async function createMnemonicServer<T>(
  config: MnemonicServerConfig,
  ServerClass: new (opts: ManifestMCPServerOptions) => T,
): Promise<T> {
  const { mnemonic, ...mcpConfig } = config;
  const validatedConfig = createValidatedConfig(mcpConfig);
  const walletProvider = new MnemonicWalletProvider(validatedConfig, mnemonic);
  await walletProvider.connect();

  return new ServerClass({
    config: validatedConfig,
    walletProvider,
  });
}
