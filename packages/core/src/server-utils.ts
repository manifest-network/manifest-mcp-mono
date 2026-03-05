import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ManifestMCPError, type ManifestMCPConfig, type WalletProvider } from './types.js';
import { MnemonicWalletProvider } from './wallet/index.js';
import { createValidatedConfig } from './config.js';

/**
 * Sensitive field names that should be redacted from error responses
 */
export const SENSITIVE_FIELDS = new Set([
  'mnemonic',
  'privatekey',
  'private_key',
  'secret',
  'password',
  'seed',
  'apikey',
  'api_key',
  'auth_token',
  'bearer_token',
  'access_token',
  'refresh_token',
]);

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
    // Redact strings that look like mnemonics (12 or 24 words)
    const wordCount = obj.trim().split(/\s+/).length;
    if (wordCount === 12 || wordCount === 24) {
      return '[REDACTED - possible mnemonic]';
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLogging(item, depth + 1));
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
 * Options for creating a chain or cloud MCP server
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
export function withErrorHandling<T extends (...args: any[]) => CallToolResult | Promise<CallToolResult>>(
  toolName: string,
  fn: T,
): T {
  // For tools with no inputSchema, McpServer calls cb(extra) with one arg.
  // For tools with inputSchema, McpServer calls cb(parsedArgs, extra).
  // We infer from cbArgs.length at call time (not fn.length) so default parameters are safe.
  const wrapped = async (...cbArgs: any[]) => {
    const hasArgs = cbArgs.length >= 2;
    const args = hasArgs ? (cbArgs[0] ?? {}) : {};
    try {
      return hasArgs ? await fn(args, cbArgs[1]) : await fn(cbArgs[0]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof ManifestMCPError ? error.code : 'UNKNOWN';
      if (error instanceof ManifestMCPError) {
        console.error(`[${toolName}] Tool error [${errorCode}]: ${errorMessage}`);
      } else {
        console.error(`[${toolName}] Tool error [${errorCode}]:`, error);
      }

      let errorResponse: Record<string, unknown> = {
        error: true,
        tool: toolName,
        input: sanitizeForLogging(args),
      };

      if (error instanceof ManifestMCPError) {
        errorResponse = {
          ...errorResponse,
          code: error.code,
          message: error.message,
          details: sanitizeForLogging(error.details),
        };
      } else {
        errorResponse = {
          ...errorResponse,
          message: errorMessage,
        };
      }

      let responseText: string;
      try {
        responseText = JSON.stringify(errorResponse, bigIntReplacer, 2);
      } catch (stringifyError) {
        console.error(
          `[${toolName}] Failed to serialize error response: ${stringifyError instanceof Error ? stringifyError.message : String(stringifyError)}`
        );
        responseText = JSON.stringify({
          error: true,
          tool: toolName,
          message: errorMessage,
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
export function jsonResponse(data: unknown, replacer?: (key: string, value: any) => any): CallToolResult {
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
 * Config shape accepted by createMnemonicServer.
 */
export interface MnemonicServerConfig {
  chainId: string;
  rpcUrl: string;
  gasPrice: string;
  addressPrefix?: string;
  mnemonic: string;
}

/**
 * Generic factory that creates any MCP server class with a mnemonic wallet.
 *
 * Eliminates the duplicated createMnemonicChainServer / createMnemonicCloudServer
 * pattern -- callers pass the server constructor instead.
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
