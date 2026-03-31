import { DEFAULT_RETRY_CONFIG } from './retry.js';
import {
  type ManifestMCPConfig,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from './types.js';

/**
 * Default address prefix for Manifest Network
 */
const DEFAULT_ADDRESS_PREFIX = 'manifest';

/**
 * Default requests per second for rate limiting
 */
export const DEFAULT_REQUESTS_PER_SECOND = 10;

/**
 * Default gas simulation multiplier. CosmJS defaults to 1.4 but billing module
 * transactions (close-lease in particular) can exceed that. 1.5 matches
 * the --gas-adjustment default used by the manifestd CLI.
 */
export const DEFAULT_GAS_MULTIPLIER = 1.5;

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
function validateEndpointUrl(
  url: string,
  label: string,
): { valid: true } | { valid: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: `${label} must be a valid URL` };
  }

  if (parsed.protocol === 'https:') {
    return { valid: true };
  }

  if (parsed.protocol === 'http:' && isLocalhostHostname(parsed.hostname)) {
    return { valid: true }; // HTTP allowed for localhost
  }

  return {
    valid: false,
    reason: `${label} must use HTTPS (got ${parsed.protocol}//). HTTP is only allowed for local development (localhost, 127.0.0.1, ::1).`,
  };
}

/**
 * Validate gas price format (e.g., "1.0umfx")
 */
function isValidGasPrice(gasPrice: string): boolean {
  // Gas price should be a number followed by a denomination.
  // Denoms can be simple (umfx), IBC (ibc/ABC123...), or factory
  // (factory/manifest1.../utoken). Denoms are made of non-empty segments
  // separated by '/', with the first segment starting with a letter.
  // Each segment may contain letters, digits, dots, colons, underscores,
  // and hyphens. Denom length must be 3-128 chars per the Cosmos SDK spec.
  const match = gasPrice.match(
    /^(\d+(?:\.\d+)?)([a-zA-Z][a-zA-Z0-9.:_-]*(?:\/[a-zA-Z0-9.:_-]+)*)$/,
  );
  if (!match) {
    return false;
  }
  const denom = match[2];
  return denom.length >= 3 && denom.length <= 128;
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
    restUrl: input.restUrl,
    addressPrefix: input.addressPrefix ?? DEFAULT_ADDRESS_PREFIX,
    rateLimit: {
      requestsPerSecond:
        input.rateLimit?.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND,
    },
    retry: {
      maxRetries: input.retry?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
      baseDelayMs: input.retry?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
      maxDelayMs: input.retry?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs,
    },
    gasMultiplier: input.gasMultiplier ?? DEFAULT_GAS_MULTIPLIER,
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
export function validateConfig(
  config: Partial<ManifestMCPConfig>,
): ValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!config.chainId) {
    errors.push('chainId is required');
  } else if (!isValidChainId(config.chainId)) {
    errors.push(
      'chainId must be alphanumeric with hyphens (e.g., "manifest-ledger-testnet")',
    );
  }

  // At least one of rpcUrl or restUrl must be provided
  if (!config.rpcUrl && !config.restUrl) {
    errors.push('At least one of rpcUrl or restUrl is required');
  }

  if (config.rpcUrl) {
    const urlCheck = validateEndpointUrl(config.rpcUrl, 'rpcUrl');
    if (!urlCheck.valid) {
      errors.push(urlCheck.reason);
    }
  }

  if (config.restUrl) {
    const urlCheck = validateEndpointUrl(config.restUrl, 'restUrl');
    if (!urlCheck.valid) {
      errors.push(urlCheck.reason);
    }
  }

  // gasPrice required when rpcUrl is provided (needed for signing)
  if (config.rpcUrl && !config.gasPrice) {
    errors.push('gasPrice is required when rpcUrl is provided');
  } else if (config.gasPrice && !isValidGasPrice(config.gasPrice)) {
    errors.push(
      'gasPrice must be a number followed by denomination (e.g., "1.0umfx", "0.5factory/addr/udenom", or "0.25ibc/ABC123")',
    );
  }

  // Optional fields
  if (config.addressPrefix !== undefined) {
    if (!/^[a-z]+$/.test(config.addressPrefix)) {
      errors.push('addressPrefix must be lowercase letters only');
    }
  }

  if (config.rateLimit !== undefined) {
    if (
      typeof config.rateLimit !== 'object' ||
      config.rateLimit === null ||
      Array.isArray(config.rateLimit)
    ) {
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
    if (
      typeof config.retry !== 'object' ||
      config.retry === null ||
      Array.isArray(config.retry)
    ) {
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
        errors.push(
          'retry.maxDelayMs must be greater than or equal to retry.baseDelayMs',
        );
      }
    }
  }

  if (config.gasMultiplier !== undefined) {
    if (
      typeof config.gasMultiplier !== 'number' ||
      !Number.isFinite(config.gasMultiplier) ||
      config.gasMultiplier < 1
    ) {
      errors.push('gasMultiplier must be a finite number >= 1');
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
export function createValidatedConfig(
  input: ManifestMCPConfig,
): ManifestMCPConfig {
  const validation = validateConfig(input);

  if (!validation.valid) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      `Invalid configuration: ${validation.errors.join(', ')}`,
      { errors: validation.errors },
    );
  }

  return createConfig(input);
}
