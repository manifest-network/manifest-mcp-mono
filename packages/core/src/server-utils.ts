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
 * Normalize a key name before sensitive-name matching: lowercase, and drop the
 * separators that distinguish one name's spellings. `auth_token`, `authToken`,
 * `AUTH_TOKEN` and `auth-token` all normalize to `authtoken`.
 *
 * Matching on the raw lowercased key (the pre-ENG-747 behavior) meant a set of
 * snake_case names silently missed every camelCase spelling — the dominant
 * convention in this codebase's own TypeScript. `'authToken'.toLowerCase()` is
 * `'authtoken'`, which was in no list, so the token reached model context and
 * stderr verbatim through `withErrorHandling`'s `input:` echo.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/**
 * Sensitive field names matched EXACTLY (after normalization). These are the
 * names too generic to match as a substring: `seed` must not redact `seedNode`
 * (a p2p seed node), `session` must not redact `sessionCount`.
 *
 * Written in the conventional snake_case spelling and exported on the package
 * barrel — this is human-readable policy data, the same shape as Sentry's
 * `DEFAULT_DENYLIST` or Rails' `filter_parameters`. Normalization is applied to
 * a DERIVED lookup set below, never to this one, so the published list stays
 * readable, stays additive across releases, and would absorb a caller-supplied
 * entry in any casing if this is ever made extensible.
 *
 * To TEST a key, call `isSensitiveKey` — a raw `.has()` on this set is an exact
 * match and will miss `authToken`, which is the whole of ENG-747.
 *
 * Kept as a complete inventory even where a stem below already subsumes an
 * entry, so the set reads as the documentation of what counts as a secret name.
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
  // ENG-271(b) additions.
  'passphrase',
  'priv_key',
  'authorization',
  'bearer',
  'jwt',
  'session',
  'session_id',
  'cookie',
  'credential',
  'credentials',
]);

/**
 * Sensitive name STEMS, matched as a SUBSTRING of the normalized key. This is
 * the Rails `filter_parameters` idiom ("partially matched — `passw` matches
 * `password`"), and it is what catches the compounds nobody enumerates:
 * `DB_PASSWORD`, `walletPassword`, `X-Auth-Token`, `proxy-authorization`,
 * `clientSecret`.
 *
 * A family earns a stem only when it has no benign compound in this domain.
 */
export const SENSITIVE_KEY_STEMS: readonly string[] = [
  'password',
  'passphrase',
  'mnemonic',
  'secret',
  'private_key',
  'priv_key',
  'api_key',
  'signing_key',
  'auth_token',
  'bearer_token',
  'access_token',
  'refresh_token',
  'authorization',
  'credential',
  'jwt',
  'cookie',
];

// Normalized forms, DERIVED from the two published lists at module init. This is
// Sentry's `[x.lower() for x in self.denylist]` move, generalized to strip `_`
// and `-` as well: the library adapts to however the policy is written instead
// of demanding it be pre-normalized. Deriving rather than publishing the
// normalized shape is what keeps `SENSITIVE_FIELDS` additive — an earlier cut of
// ENG-747 normalized the exported set itself, which silently changed
// `SENSITIVE_FIELDS.has('auth_token')` from true to false for consumers.
const NORMALIZED_SENSITIVE_FIELDS: ReadonlySet<string> = new Set(
  [...SENSITIVE_FIELDS].map(normalizeKey),
);
const NORMALIZED_SENSITIVE_KEY_STEMS: readonly string[] =
  SENSITIVE_KEY_STEMS.map(normalizeKey);

// Bare "key" and "token" are deliberately absent from BOTH lists above, and are
// deliberately NOT stems. Rails and Django both substring-match them; this repo
// cannot, because they are first-class Cosmos domain nouns. Measured against
// the tree: a `key` stem would redact `pub_key` (a PUBLIC key), `next_key` /
// `nextKey` (pagination cursors), `env_key`, `keygen` and `keyfileWallet`; a
// `token` stem would redact `gas_token`, `fee_token`, `chain_token`, `token_id`
// and `token_symbol`. Rails anchors this case as `_key`; we go one notch
// tighter and keep those families exact-match only. `secret` DOES earn a stem —
// the tree contains no benign `*secret*` field name.
//
// Use compound names (api_key, auth_token, …) for anything that must redact.

/**
 * True when a key name denotes a secret whose value must not be logged or
 * returned to a caller.
 *
 * Single source of truth for both redactors: core's `sanitizeForLogging`
 * redacts the value in place, agent-core's `stripDenylist` drops the key.
 * Different actions, one policy — they were two lists that drifted apart, and
 * that drift is what ENG-747 / ENG-271(b) were.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (NORMALIZED_SENSITIVE_FIELDS.has(normalized)) {
    return true;
  }
  return NORMALIZED_SENSITIVE_KEY_STEMS.some((stem) =>
    normalized.includes(stem),
  );
}

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
      const sanitizedValue = isSensitiveKey(key)
        ? '[REDACTED]'
        : sanitizeForLogging(value, depth + 1);
      // defineProperty, not `sanitized[key] = …`: a plain assignment on a `{}`
      // literal routes a `__proto__` key through Object.prototype's setter,
      // which silently DROPS a string value and re-parents the result object
      // for an object value. defineProperty always creates an own property, so
      // the key round-trips as data — no pollution, and no data loss. (A
      // redactor must not silently delete fields from an error payload, which
      // is why this differs from agent-core's drop-the-key `stripDenylist`.)
      Object.defineProperty(sanitized, key, {
        value: sanitizedValue,
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
 * Iterates lazily by CODE POINT rather than materializing a remote response as
 * a potentially multi-million-element array. Control/format chars — including the ZWJ that binds
 * emoji sequences — are already stripped upstream, so code-point capping is
 * sufficient and avoids an `Intl.Segmenter` (grapheme) dependency.
 */
function capLength(s: string, maxCodePoints: number): string {
  // Defensive: a non-negative integer cap is the only meaningful input. A bad
  // cap (NaN / Infinity / negative / fractional) means "no truncation" rather
  // than the surprising `slice` behavior it would otherwise produce — consistent
  // with this helper's defensive treatment of its other inputs.
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 0) return s;
  let end = 0;
  let count = 0;
  for (const point of s) {
    if (count === maxCodePoints) return `${s.slice(0, end)}…`;
    end += point.length;
    count += 1;
  }
  return s;
}

/**
 * Budget for any error message on its way into model
 * context. ~500 tokens — half of `MAX_LOG_CHARS`'s single-copy budget for a
 * *successful* log fetch, which is the right order for an error path.
 *
 * `sanitizeForLogging` redacts secrets but never truncates, so before ENG-669 a
 * provider could put its entire response body (up to the 10 MiB transport cap)
 * into a tool's error response verbatim.
 */
export const MAX_TOOL_ERROR_MESSAGE_CHARS = 2000;

/** Maximum serialized JSON text for the complete MCP error, including input/details. */
export const MAX_TOOL_ERROR_RESPONSE_CHARS = 8000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: the purpose is to remove terminal CSI control sequences.
const MODEL_ANSI_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the purpose is to remove terminal OSC control sequences.
const MODEL_ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Sanitize text for model context without flattening logs or diagnostic lines.
 * Removes terminal CSI/OSC sequences and other control/format characters, keeping
 * newlines and tabs. Raw SDK error objects are never modified by this projection.
 */
export function sanitizeForModelText(
  raw: string,
  maxLength = MAX_TOOL_ERROR_MESSAGE_CHARS,
): string {
  const cleaned = raw
    .replace(MODEL_ANSI_CSI, '')
    .replace(MODEL_ANSI_OSC, '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) =>
      ch === '\n' || ch === '\t' ? ch : '',
    );
  // Match the visible value too: terminal/bidi controls must not hide a mnemonic
  // from the redactor and then reveal it as a side effect of sanitization.
  return capLength(sanitizeForLogging(cleaned) as string, maxLength);
}

// Reserve scarce space for the identifiers and facts a caller needs to reconcile
// side effects. Both snake_case and camelCase spellings normalize to these names.
const RECOVERY_FIELDS = new Set([
  'code',
  'leaseuuid',
  'sourceleaseuuid',
  'orphanedleaseuuid',
  'newleaseuuid',
  'provideruuid',
  'sourceprovideruuid',
  'transactionhash',
  'txhash',
  'hash',
  'partial',
  'sent',
  'committed',
  'adoptionstatus',
  'rolledback',
  'recoverable',
  'recoveryoutcome',
  'stopoutcome',
  'leasestate',
  'restorestatus',
  'nextaction',
  'readinessunconfirmed',
  'retryafterms',
  'name',
  'message',
]);

interface ErrorProjectionState {
  truncated: boolean;
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

/** Fit a string to its JSON-encoded budget, accounting for escaped newlines/quotes. */
function fitErrorString(
  value: string,
  budget: number,
  state: ErrorProjectionState,
): string {
  const clean = sanitizeForModelText(value);
  if (clean.endsWith('…') && clean !== value) state.truncated = true;
  if (JSON.stringify(clean).length <= budget) return clean;
  state.truncated = true;
  let low = 0;
  let high = Math.min(clean.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(`${clean.slice(0, mid)}…`).length <= budget) low = mid;
    else high = mid - 1;
  }
  // Avoid cutting a UTF-16 surrogate pair at the budget boundary.
  const lastCodeUnit = clean.charCodeAt(low - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) low -= 1;
  return `${clean.slice(0, low)}…`;
}

/** Bounded traversal of data properties only: never run getters or custom toJSON. */
function projectErrorValue(
  value: unknown,
  budget: number,
  state: ErrorProjectionState,
  depth = 0,
): unknown {
  if (++state.nodes > 256 || depth > 6) {
    state.truncated = true;
    return '[omitted]';
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return fitErrorString(value, budget, state);
  if (typeof value === 'bigint')
    return fitErrorString(value.toString(), budget, state);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') {
    state.truncated = true;
    return '[unsupported value]';
  }
  if (state.ancestors.has(value)) {
    state.truncated = true;
    return '[circular]';
  }
  state.ancestors.add(value);
  try {
    const array = Array.isArray(value);
    const projected: Record<string, unknown> | unknown[] = array
      ? []
      : Object.create(null);
    let used = 2;
    const keys = Object.keys(value);
    // Error.message is normally non-enumerable, but is useful when an Error is a
    // nested cancellation reason or cause. Descriptor reads keep getters inert.
    if (value instanceof Error && !keys.includes('message'))
      keys.unshift('message');
    if (!array)
      keys.sort(
        (a, b) =>
          Number(!RECOVERY_FIELDS.has(normalizeKey(a))) -
          Number(!RECOVERY_FIELDS.has(normalizeKey(b))),
      );
    for (const rawKey of keys) {
      if (state.nodes >= 256 || used + 32 >= budget) {
        state.truncated = true;
        break;
      }
      const key = sanitizeForModelText(rawKey, 128);
      if (
        rawKey.length > 128 ||
        Object.getOwnPropertyDescriptor(projected, key) !== undefined
      ) {
        state.truncated = true;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
      if (!descriptor) continue;
      const overhead = array ? 1 : JSON.stringify(key).length + 2;
      const childBudget = budget - used - overhead;
      if (childBudget < 32) {
        state.truncated = true;
        continue;
      }
      let child: unknown;
      if (isSensitiveKey(key)) child = '[REDACTED]';
      else if (!('value' in descriptor)) {
        state.truncated = true;
        child = '[accessor omitted]';
      } else
        child = projectErrorValue(
          descriptor.value,
          childBudget,
          state,
          depth + 1,
        );
      if (child === undefined) continue;
      const encoded = JSON.stringify(child);
      if (used + overhead + encoded.length > budget) {
        state.truncated = true;
        continue;
      }
      if (array) (projected as unknown[]).push(child);
      else
        Object.defineProperty(projected, key, {
          value: child,
          enumerable: true,
        });
      used += overhead + encoded.length;
    }
    return projected;
  } catch {
    state.truncated = true;
    return '[unavailable]';
  } finally {
    state.ancestors.delete(value);
  }
}

function errorResponseText(
  tool: string,
  message: string,
  args: unknown,
  error: unknown,
): string {
  const state: ErrorProjectionState = {
    truncated: false,
    nodes: 0,
    ancestors: new WeakSet(),
  };
  const response: Record<string, unknown> = {
    error: true,
    tool: fitErrorString(tool, 200, state),
    ...(error instanceof ManifestMCPError && {
      code: fitErrorString(error.code, 200, state),
    }),
    message: fitErrorString(message, 3000, state),
  };
  // Compact JSON makes the budget deterministic. Details precede input because
  // recovery handles must survive even when the echoed arguments contain a blob.
  for (const [key, value] of [
    ['details', error instanceof ManifestMCPError ? error.details : undefined],
    ['input', args],
  ] as const) {
    if (value === undefined) continue;
    const remaining =
      MAX_TOOL_ERROR_RESPONSE_CHARS -
      JSON.stringify(response).length -
      key.length -
      40;
    if (remaining < 32) {
      state.truncated = true;
      continue;
    }
    response[key] = projectErrorValue(value, remaining, state);
  }
  if (state.truncated) response.truncated = true;
  return JSON.stringify(response);
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
      let errorMessage: string;
      try {
        errorMessage =
          error instanceof Error ? String(error.message) : String(error);
      } catch {
        errorMessage = 'Error message unavailable';
      }
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

      let responseText: string;
      try {
        responseText = errorResponseText(toolName, safeMessage, args, error);
      } catch (stringifyError) {
        logger.error(
          `[${toolName}] Failed to serialize error response: ${stringifyError instanceof Error ? stringifyError.message : String(stringifyError)}`,
        );
        const state: ErrorProjectionState = {
          truncated: true,
          nodes: 0,
          ancestors: new WeakSet(),
        };
        responseText = JSON.stringify({
          error: true,
          tool: fitErrorString(toolName, 200, state),
          ...(error instanceof ManifestMCPError && {
            code: fitErrorString(errorCode, 200, state),
          }),
          message: fitErrorString(safeMessage, 3000, state),
          truncated: true,
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
  if (serialized === undefined) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ARGUMENT,
      'structuredResponse requires a JSON object; the supplied value is not JSON-serializable.',
    );
  }
  const parsed: unknown = JSON.parse(serialized);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ARGUMENT,
      'structuredResponse requires a JSON object after serialization; arrays, null, and primitive values are not valid structuredContent.',
    );
  }
  const structuredContent = parsed as Record<string, unknown>;
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
