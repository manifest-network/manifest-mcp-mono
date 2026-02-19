import { SigningStargateClient } from '@cosmjs/stargate';
import { fromBech32, fromHex, toHex } from '@cosmjs/encoding';
import { ManifestMCPError, ManifestMCPErrorCode, CosmosTxResult } from '../types.js';

/** Maximum number of arguments allowed */
export const MAX_ARGS = 100;

/** Maximum meta hash length in bytes (64 bytes for SHA-512) */
export const MAX_META_HASH_BYTES = 64;

/**
 * Result from extracting a flag from args
 */
export interface ExtractedFlag {
  /** The flag value, or undefined if flag not present */
  value: string | undefined;
  /** Indices consumed by the flag and its value (for filtering) */
  consumedIndices: number[];
}

/**
 * Extract a flag value from args array.
 * Returns { value, consumedIndices } or { value: undefined, consumedIndices: [] } if flag not present.
 * Throws if flag is present but value is missing or looks like another flag.
 *
 * @param args - The arguments array to search
 * @param flagName - The flag to look for (e.g., '--memo')
 * @param context - Description for error messages (e.g., 'bank send')
 */
export function extractFlag(
  args: string[],
  flagName: string,
  context: string
): ExtractedFlag {
  const flagIndex = args.indexOf(flagName);
  if (flagIndex === -1) {
    return { value: undefined, consumedIndices: [] };
  }

  const value = args[flagIndex + 1];
  if (!value || value.startsWith('--')) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `${flagName} flag requires a value in ${context}`
    );
  }

  return { value, consumedIndices: [flagIndex, flagIndex + 1] };
}

/**
 * Result from extracting a boolean (valueless) flag from args
 */
export interface ExtractedBooleanFlag {
  /** Whether the flag was present */
  value: boolean;
  /** Args with the flag removed */
  remainingArgs: string[];
}

/**
 * Extract a valueless boolean flag from args array.
 * Returns { value: true, remainingArgs } if flag is present, { value: false, remainingArgs: args } otherwise.
 *
 * @param args - The arguments array to search
 * @param flagName - The flag to look for (e.g., '--active-only')
 * @returns Object with boolean value and filtered args
 */
export function extractBooleanFlag(args: string[], flagName: string): ExtractedBooleanFlag {
  const flagIndex = args.indexOf(flagName);
  if (flagIndex === -1) {
    return { value: false, remainingArgs: args };
  }
  const remainingArgs = args.filter((_, index) => index !== flagIndex);
  return { value: true, remainingArgs };
}

/**
 * Filter args to remove consumed flag indices
 */
export function filterConsumedArgs(args: string[], consumedIndices: number[]): string[] {
  if (consumedIndices.length === 0) {
    return args;
  }
  const consumedSet = new Set(consumedIndices);
  return args.filter((_, index) => !consumedSet.has(index));
}

/** Maximum memo length (Cosmos SDK default) */
export const MAX_MEMO_LENGTH = 256;

/**
 * Parse a colon-separated pair (e.g., "address:amount", "sku:quantity").
 * Throws with helpful error if format is invalid.
 *
 * @param input - The string to parse (e.g., "manifest1abc:1000umfx")
 * @param leftName - Name of the left value for error messages (e.g., "address")
 * @param rightName - Name of the right value for error messages (e.g., "amount")
 * @param context - Context for error messages (e.g., "multi-send pair")
 * @returns Tuple of [left, right] values
 */
export function parseColonPair(
  input: string,
  leftName: string,
  rightName: string,
  context: string
): [string, string] {
  const colonIndex = input.indexOf(':');
  if (colonIndex === -1) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid ${context} format: "${input}". Missing colon separator. Expected format: ${leftName}:${rightName}`
    );
  }
  if (colonIndex === 0) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid ${context} format: "${input}". Missing ${leftName}. Expected format: ${leftName}:${rightName}`
    );
  }
  if (colonIndex === input.length - 1) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid ${context} format: "${input}". Missing ${rightName}. Expected format: ${leftName}:${rightName}`
    );
  }
  return [input.slice(0, colonIndex), input.slice(colonIndex + 1)];
}

/**
 * Validate args array length (max limit)
 */
export function validateArgsLength(args: string[], context: string): void {
  if (args.length > MAX_ARGS) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Too many arguments for ${context}: ${args.length}. Maximum allowed: ${MAX_ARGS}`
    );
  }
}

/**
 * Validate that required arguments are present.
 * Provides helpful error messages with received vs expected args.
 *
 * @param args - The arguments array to validate
 * @param minCount - Minimum number of required arguments
 * @param expectedNames - Names of expected arguments for error messages
 * @param context - Context for error messages (e.g., 'bank send', 'staking delegate')
 * @param errorCode - Error code to use (defaults to TX_FAILED)
 * @throws ManifestMCPError if args.length < minCount
 */
export function requireArgs(
  args: string[],
  minCount: number,
  expectedNames: string[],
  context: string,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.TX_FAILED
): void {
  if (args.length >= minCount) {
    return;
  }

  const expectedList = expectedNames.slice(0, minCount).join(', ');
  const receivedList = args.length === 0
    ? 'none'
    : args.map(a => `"${a}"`).join(', ');

  throw new ManifestMCPError(
    errorCode,
    `${context} requires ${minCount} argument(s): ${expectedList}. Received ${args.length}: ${receivedList}`,
    {
      expectedArgs: expectedNames.slice(0, minCount),
      receivedArgs: args,
      receivedCount: args.length,
      requiredCount: minCount,
    }
  );
}

/**
 * Validate a bech32 address using @cosmjs/encoding
 */
export function validateAddress(address: string, fieldName: string, expectedPrefix?: string): void {
  if (!address || address.trim() === '') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      `${fieldName} is required`
    );
  }

  try {
    const { prefix } = fromBech32(address);
    if (expectedPrefix && prefix !== expectedPrefix) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_ADDRESS,
        `Invalid ${fieldName}: "${address}". Expected prefix "${expectedPrefix}", got "${prefix}"`
      );
    }
  } catch (error) {
    if (error instanceof ManifestMCPError) {
      throw error;
    }
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      `Invalid ${fieldName}: "${address}". Not a valid bech32 address.`
    );
  }
}

/**
 * Validate memo length
 */
export function validateMemo(memo: string): void {
  if (memo.length > MAX_MEMO_LENGTH) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Memo too long: ${memo.length} characters. Maximum allowed: ${MAX_MEMO_LENGTH}`
    );
  }
}

/**
 * Parse and validate a hex string into Uint8Array.
 * Uses @cosmjs/encoding for browser compatibility.
 *
 * @param hexString - The hex string to parse
 * @param fieldName - Name of the field for error messages
 * @param maxBytes - Maximum allowed byte length
 * @param errorCode - Error code to use (defaults to TX_FAILED)
 * @returns Uint8Array of the parsed bytes
 */
export function parseHexBytes(
  hexString: string,
  fieldName: string,
  maxBytes: number,
  errorCode: ManifestMCPErrorCode = ManifestMCPErrorCode.TX_FAILED
): Uint8Array {
  // Check for empty string
  if (!hexString || hexString.trim() === '') {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${fieldName}: empty value. Expected a hex string.`
    );
  }

  // Check even length (each byte is 2 hex chars)
  if (hexString.length % 2 !== 0) {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${fieldName}: hex string must have even length. Got ${hexString.length} characters.`
    );
  }

  // Check max length
  const byteLength = hexString.length / 2;
  if (byteLength > maxBytes) {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${fieldName}: exceeds maximum ${maxBytes} bytes. Got ${byteLength} bytes (${hexString.length} hex chars).`
    );
  }

  // Use @cosmjs/encoding for browser-compatible hex parsing
  try {
    return fromHex(hexString);
  } catch (error) {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${fieldName}: "${hexString}". Must contain only hexadecimal characters (0-9, a-f, A-F).`
    );
  }
}

/**
 * Convert Uint8Array to hex string.
 * Uses @cosmjs/encoding for browser compatibility.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return toHex(bytes);
}

/**
 * Safely parse a string to BigInt with proper error handling and configurable error code.
 * This is the base implementation used by both transaction and query utilities.
 */
export function parseBigIntWithCode(
  value: string,
  fieldName: string,
  errorCode: ManifestMCPErrorCode
): bigint {
  // Check for empty string explicitly (BigInt('') returns 0n, not an error)
  if (!value || value.trim() === '') {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${fieldName}: empty value. Expected a valid integer.`
    );
  }

  try {
    return BigInt(value);
  } catch {
    throw new ManifestMCPError(
      errorCode,
      `Invalid ${fieldName}: "${value}". Expected a valid integer.`
    );
  }
}

/**
 * Safely parse a string to BigInt with proper error handling (for transactions)
 */
export function parseBigInt(value: string, fieldName: string): bigint {
  return parseBigIntWithCode(value, fieldName, ManifestMCPErrorCode.TX_FAILED);
}

/**
 * Interface for VoteOption-like enums from cosmos protobuf modules.
 * Both cosmos.gov.v1.VoteOption and cosmos.group.v1.VoteOption share this shape.
 */
interface VoteOptionEnum {
  VOTE_OPTION_YES: number;
  VOTE_OPTION_ABSTAIN: number;
  VOTE_OPTION_NO: number;
  VOTE_OPTION_NO_WITH_VETO: number;
}

/**
 * Parse a vote option string to its numeric enum value.
 * Accepts case-insensitive strings or numeric identifiers.
 *
 * @param optionStr - Vote option string (yes, no, abstain, no_with_veto, or 1-4)
 * @param voteOptionEnum - The VoteOption enum object from the relevant cosmos module
 */
export function parseVoteOption(optionStr: string, voteOptionEnum: VoteOptionEnum): number {
  const option = optionStr.toLowerCase();
  switch (option) {
    case 'yes':
    case '1':
      return voteOptionEnum.VOTE_OPTION_YES;
    case 'abstain':
    case '2':
      return voteOptionEnum.VOTE_OPTION_ABSTAIN;
    case 'no':
    case '3':
      return voteOptionEnum.VOTE_OPTION_NO;
    case 'no_with_veto':
    case 'nowithveto':
    case '4':
      return voteOptionEnum.VOTE_OPTION_NO_WITH_VETO;
    default:
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Invalid vote option: ${optionStr}. Expected: yes, no, abstain, or no_with_veto`
      );
  }
}

/** RFC 1123 DNS label pattern: 1-63 lowercase alphanumeric or hyphens, no leading/trailing hyphen */
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Parsed lease item with optional service name for stack deployments.
 */
export interface ParsedLeaseItem {
  skuUuid: string;
  quantity: bigint;
  serviceName: string;
}

/**
 * Parse a lease item string in the format "sku-uuid:quantity" or "sku-uuid:quantity:service-name".
 * The service-name is optional and used for stack (multi-service) deployments.
 *
 * @param input - The string to parse (e.g., "sku-123:1" or "sku-123:1:web")
 * @returns Parsed lease item with skuUuid, quantity, and serviceName
 */
export function parseLeaseItem(input: string): ParsedLeaseItem {
  const parts = input.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid lease item format: "${input}". Expected sku-uuid:quantity or sku-uuid:quantity:service-name`
    );
  }

  const [skuUuid, quantityStr, serviceName] = parts;

  if (!skuUuid) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid lease item format: "${input}". Missing sku-uuid.`
    );
  }

  if (!quantityStr) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid lease item format: "${input}". Missing quantity.`
    );
  }

  const quantity = parseBigInt(quantityStr, 'quantity');

  if (serviceName !== undefined) {
    if (!serviceName) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Invalid lease item format: "${input}". Empty service-name after trailing colon.`
      );
    }
    if (!DNS_LABEL_RE.test(serviceName)) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Invalid service name: "${serviceName}". Must be a valid RFC 1123 DNS label: ` +
        `1-63 lowercase alphanumeric characters or hyphens, must not start or end with a hyphen.`
      );
    }
  }

  return { skuUuid, quantity, serviceName: serviceName ?? '' };
}

/**
 * Parse amount string into coin (e.g., "1000umfx" -> { amount: "1000", denom: "umfx" })
 * Supports simple denoms (umfx), IBC denoms (ibc/...), and factory denoms (factory/creator/subdenom)
 */
export function parseAmount(amountStr: string): { amount: string; denom: string } {
  // Regex supports alphanumeric denoms with slashes and underscores for IBC/factory denoms
  const match = amountStr.match(/^(\d+)([a-zA-Z][a-zA-Z0-9/_]*)$/);
  if (!match) {
    // Provide specific hints based on common mistakes
    let hint = '';
    if (!amountStr || amountStr.trim() === '') {
      hint = ' Received empty string.';
    } else if (amountStr.includes(' ')) {
      hint = ' Remove the space between number and denom.';
    } else if (amountStr.includes(',')) {
      hint = ' Do not use commas in the number.';
    } else if (/^\d+$/.test(amountStr)) {
      hint = ' Missing denomination (e.g., add "umfx" after the number).';
    } else if (/^[a-zA-Z]/.test(amountStr)) {
      hint = ' Amount must start with a number, not the denomination.';
    }

    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid amount format: "${amountStr}".${hint} Expected format: <number><denom> (e.g., "1000000umfx" or "1000000factory/address/subdenom")`,
      { receivedValue: amountStr, expectedFormat: '<number><denom>', example: '1000000umfx' }
    );
  }
  return { amount: match[1], denom: match[2] };
}

/**
 * Build transaction result from DeliverTxResponse
 */
export function buildTxResult(
  module: string,
  subcommand: string,
  result: Awaited<ReturnType<SigningStargateClient['signAndBroadcast']>>,
  waitForConfirmation: boolean
): CosmosTxResult {
  return {
    module,
    subcommand,
    transactionHash: result.transactionHash,
    code: result.code,
    height: String(result.height),
    rawLog: result.rawLog || undefined,
    gasUsed: String(result.gasUsed),
    gasWanted: String(result.gasWanted),
    events: result.events,
    ...(waitForConfirmation && {
      confirmed: result.code === 0,
      confirmationHeight: String(result.height),
    }),
  };
}
