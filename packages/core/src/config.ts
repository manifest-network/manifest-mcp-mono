import { ManifestMCPConfig, ManifestMCPError, ManifestMCPErrorCode } from './types.js';
import { DEFAULT_RETRY_CONFIG } from './retry.js';

/**
 * Default address prefix for Manifest Network
 */
const DEFAULT_ADDRESS_PREFIX = 'manifest';

/**
 * Default requests per second for rate limiting
 */
export const DEFAULT_REQUESTS_PER_SECOND = 10;

// Re-export for consumers
export { DEFAULT_RETRY_CONFIG };

/**
 * Check if a hostname is localhost (IPv4, IPv6, or hostname)
 * Handles both bracketed and unbracketed IPv6 formats
 */
function isLocalhostHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return true;
  }
  // Handle IPv6 localhost - hostname may be '::1' or '[::1]' depending on environment
  const normalizedHostname = hostname.replace(/^\[|\]$/g, '');
  return normalizedHostname === '::1';
}

/**
 * Validate URL format and check if it uses HTTPS or is localhost (HTTP allowed for local dev)
 * Returns validation result with error reason if invalid
 */
function validateRpcUrl(url: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'rpcUrl must be a valid URL' };
  }

  if (parsed.protocol === 'https:') {
    return { valid: true };
  }

  if (parsed.protocol === 'http:' && isLocalhostHostname(parsed.hostname)) {
    return { valid: true }; // HTTP allowed for localhost
  }

  return {
    valid: false,
    reason: `RPC URL must use HTTPS (got ${parsed.protocol}//). HTTP is only allowed for local development (localhost, 127.0.0.1, ::1).`,
  };
}

/**
 * Validate gas price format (e.g., "1.0umfx")
 */
function isValidGasPrice(gasPrice: string): boolean {
  // Gas price should be a number followed by a denomination
  return /^\d+(\.\d+)?[a-zA-Z]+$/.test(gasPrice);
}

/**
 * Validate chain ID format
 */
function isValidChainId(chainId: string): boolean {
  // Chain ID should be alphanumeric with hyphens
  return /^[a-zA-Z0-9][\w-]*$/.test(chainId);
}

/**
 * Create a configuration object with defaults applied
 */
export function createConfig(input: ManifestMCPConfig): ManifestMCPConfig {
  return {
    chainId: input.chainId,
    rpcUrl: input.rpcUrl,
    gasPrice: input.gasPrice,
    addressPrefix: input.addressPrefix ?? DEFAULT_ADDRESS_PREFIX,
    rateLimit: {
      requestsPerSecond: input.rateLimit?.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND,
    },
    retry: {
      maxRetries: input.retry?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
      baseDelayMs: input.retry?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
      maxDelayMs: input.retry?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    },
  };
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a configuration object
 */
export function validateConfig(config: Partial<ManifestMCPConfig>): ValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!config.chainId) {
    errors.push('chainId is required');
  } else if (!isValidChainId(config.chainId)) {
    errors.push('chainId must be alphanumeric with hyphens (e.g., "manifest-ledger-testnet")');
  }

  if (!config.rpcUrl) {
    errors.push('rpcUrl is required');
  } else {
    const urlCheck = validateRpcUrl(config.rpcUrl);
    if (!urlCheck.valid) {
      errors.push(urlCheck.reason!);
    }
  }

  if (!config.gasPrice) {
    errors.push('gasPrice is required');
  } else if (!isValidGasPrice(config.gasPrice)) {
    errors.push('gasPrice must be a number followed by denomination (e.g., "1.0umfx")');
  }

  // Optional fields
  if (config.addressPrefix !== undefined) {
    if (!/^[a-z]+$/.test(config.addressPrefix)) {
      errors.push('addressPrefix must be lowercase letters only');
    }
  }

  if (config.rateLimit !== undefined) {
    if (typeof config.rateLimit !== 'object' || config.rateLimit === null || Array.isArray(config.rateLimit)) {
      errors.push('rateLimit must be a plain object');
    } else if (config.rateLimit.requestsPerSecond !== undefined) {
      if (
        typeof config.rateLimit.requestsPerSecond !== 'number' ||
        config.rateLimit.requestsPerSecond <= 0 ||
        !Number.isInteger(config.rateLimit.requestsPerSecond)
      ) {
        errors.push('rateLimit.requestsPerSecond must be a positive integer');
      }
    }
  }

  if (config.retry !== undefined) {
    if (typeof config.retry !== 'object' || config.retry === null || Array.isArray(config.retry)) {
      errors.push('retry must be a plain object');
    } else {
      if (config.retry.maxRetries !== undefined) {
        if (
          typeof config.retry.maxRetries !== 'number' ||
          config.retry.maxRetries < 0 ||
          !Number.isInteger(config.retry.maxRetries)
        ) {
          errors.push('retry.maxRetries must be a non-negative integer');
        }
      }
      if (config.retry.baseDelayMs !== undefined) {
        if (
          typeof config.retry.baseDelayMs !== 'number' ||
          config.retry.baseDelayMs <= 0 ||
          !Number.isInteger(config.retry.baseDelayMs)
        ) {
          errors.push('retry.baseDelayMs must be a positive integer');
        }
      }
      if (config.retry.maxDelayMs !== undefined) {
        if (
          typeof config.retry.maxDelayMs !== 'number' ||
          config.retry.maxDelayMs <= 0 ||
          !Number.isInteger(config.retry.maxDelayMs)
        ) {
          errors.push('retry.maxDelayMs must be a positive integer');
        }
      }
      // Validate maxDelayMs >= baseDelayMs if both are provided
      if (
        config.retry.baseDelayMs !== undefined &&
        config.retry.maxDelayMs !== undefined &&
        config.retry.maxDelayMs < config.retry.baseDelayMs
      ) {
        errors.push('retry.maxDelayMs must be greater than or equal to retry.baseDelayMs');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Create and validate a configuration, throwing on invalid config
 */
export function createValidatedConfig(input: ManifestMCPConfig): ManifestMCPConfig {
  const validation = validateConfig(input);

  if (!validation.valid) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Invalid configuration: ${validation.errors.join(', ')}`,
      { errors: validation.errors }
    );
  }

  return createConfig(input);
}

