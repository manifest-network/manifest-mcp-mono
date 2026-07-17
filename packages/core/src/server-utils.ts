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
 * Neutralize an UNTRUSTED string before it is placed on a HUMAN-FACING approval
 * surface (a confirmation block the user approves, an elicitation label). This
 * is the display-boundary defense for provider-controlled on-chain strings
 * (SKU name, denom) that would otherwise forge plan lines (an embedded newline
 * fakes a "Total fee" line — CWE-117/CWE-451), repaint the terminal
 * (ANSI/ESC — CWE-150), or hide/reorder text (bidi override / zero-width —
 * Trojan Source, CVE-2021-42574).
 *
 * Strip — not escape — is idiomatic for identifier-shaped values on a disposable
 * approval surface (CWE-150 "restrict to printable", Unicode UTR#36, git-annex).
 * Control/format chars become a space (so words don't fuse), whitespace is
 * collapsed, and an all-hostile value returns a conspicuous placeholder so
 * tampering never silently vanishes.
 *
 * Distinct from `sanitizeForLogging` (secret redaction). Callers keep the RAW
 * value for logic/matching — the chain is authoritative by string equality — and
 * pass it through here only where a human reads it.
 *
 * @param raw         untrusted value; typed `unknown` because this is a defensive
 *                    boundary helper — any nullish/non-string input is coerced
 *                    (`String(raw ?? '')`) rather than rejected
 * @param maxLength   cap on RETAINED CODE POINTS (default 64), applied AFTER
 *                    stripping so a surrogate pair is never bisected. When the
 *                    value is truncated a single-code-point ellipsis is
 *                    appended, so a truncated result is `maxLength + 1` long.
 * @param placeholder returned when nothing survives stripping
 */
export function sanitizeForDisplay(
  raw: unknown,
  maxLength = 64,
  placeholder = '(hidden)',
): string {
  const cleaned = String(raw ?? '')
    .normalize('NFC')
    // Cc (C0 + DEL + C1, incl. ESC and all newlines), Cf (bidi overrides,
    // zero-width, BOM, TAG block), Zl/Zp (U+2028 / U+2029). The `u` flag is
    // SAFETY-CRITICAL: without it `\p{Cc}` silently matches a literal 'p' and
    // the filter fails OPEN.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return placeholder;
  return capLength(cleaned, maxLength);
}

/**
 * Truncate to `maxCodePoints` retained code points, appending a single-code-point
 * ellipsis when truncated (so a truncated result is `maxCodePoints + 1` long).
 * Iterates by CODE POINT via `Array.from` (not `String.prototype.slice`, which
 * indexes by UTF-16 code unit and can split a surrogate pair into a
 * lone-surrogate `U+FFFD`). Control/format chars — including the ZWJ that binds
 * emoji sequences — are already stripped upstream, so code-point capping is
 * sufficient and avoids an `Intl.Segmenter` (grapheme) dependency.
 */
function capLength(s: string, maxCodePoints: number): string {
  // Defensive: a non-negative integer cap is the only meaningful input. A bad
  // cap (NaN / Infinity / negative / fractional) means "no truncation" rather
  // than the surprising `slice` behavior it would otherwise produce — consistent
  // with this helper's defensive treatment of its other inputs.
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 0) return s;
  const codePoints = Array.from(s);
  if (codePoints.length <= maxCodePoints) return s;
  return `${codePoints.slice(0, maxCodePoints).join('')}…`;
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
      // Sanitize error messages before including in the MCP response or logs.
      // This catches mnemonic-like strings in error messages and redacts them.
      const safeMessage = sanitizeForLogging(errorMessage) as string;
      const messageWasRedacted = safeMessage !== errorMessage;
      if (error instanceof ManifestMCPError) {
        logger.error(`[${toolName}] Tool error [${errorCode}]: ${safeMessage}`);
      } else {
        // Stack traces embed error.message verbatim. If the message was
        // redacted, the stack would re-leak the original — so suppress the
        // stack in that case rather than emit a half-sanitized trace.
        let stackSuffix = '';
        if (!messageWasRedacted && error instanceof Error && error.stack) {
          stackSuffix = `\n${sanitizeForLogging(error.stack) as string}`;
        }
        logger.error(
          `[${toolName}] Tool error [${errorCode}]: ${safeMessage}${stackSuffix}`,
        );
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
 * be a JSON object — `data` is typed as `unknown` so callers don't need to
 * widen typed result interfaces with double-casts; the runtime contract
 * (object-shaped after JSON round-trip) is enforced below.
 *
 * The optional `replacer` is applied to BOTH `structuredContent` and the
 * text fallback by round-tripping through JSON. This keeps `structuredContent`
 * JSON-serializable for the wire, even if the caller hands us a `BigInt`,
 * `Date`, or anything else `JSON.stringify` knows how to convert via the
 * replacer.
 */
export function structuredResponse(
  data: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches JSON.stringify's replacer signature
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
