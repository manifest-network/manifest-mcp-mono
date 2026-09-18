import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';

/** Select the provider contract explicitly; never infer it from a failed POST. */
export type FredCompatibility = 'v0.13' | 'pr240';

/** A global mode, or modes keyed by provider API URL. Unlisted providers use v0.13. */
export type FredCompatibilityConfig =
  | FredCompatibility
  | Readonly<Record<string, FredCompatibility>>;

function invalid(message: string): never {
  throw new ManifestMCPError(ManifestMCPErrorCode.INVALID_CONFIG, message);
}

function mode(value: unknown): FredCompatibility {
  if (value === 'v0.13' || value === 'pr240') return value;
  return invalid('fredCompatibility must be "v0.13" or "pr240".');
}

function providerKey(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href.replace(/\/+$/, '');
    }
  } catch {
    // Configuration diagnostics must not expose credentials from a malformed URL.
  }
  return invalid(
    'Fred compatibility maps require absolute HTTP(S) provider URLs.',
  );
}

/** Validate and snapshot configuration so caller mutations cannot switch protocols. */
export function normalizeFredCompatibility(
  config: FredCompatibilityConfig | undefined,
): FredCompatibilityConfig {
  if (config === undefined) return 'v0.13';
  if (typeof config === 'string') return mode(config);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return invalid('fredCompatibility must be a mode or a provider URL map.');
  }
  const result: Record<string, FredCompatibility> = {};
  for (const [url, value] of Object.entries(config)) {
    const key = providerKey(url);
    if (Object.keys(result).includes(key)) {
      return invalid(
        'Fred compatibility map contains duplicate provider URLs.',
      );
    }
    result[key] = mode(value);
  }
  return Object.freeze(result);
}

/** Call overrides precede provider configuration; unspecified providers stay legacy. */
export function resolveFredCompatibility(
  config: FredCompatibilityConfig | undefined,
  providerUrl?: string,
  override?: FredCompatibility,
): FredCompatibility {
  if (override !== undefined) return mode(override);
  const normalized = normalizeFredCompatibility(config);
  if (typeof normalized === 'string') return normalized;
  if (providerUrl === undefined) {
    return invalid(
      'A provider URL is required to select its Fred compatibility mode.',
    );
  }
  return normalized[providerKey(providerUrl)] ?? 'v0.13';
}

/** Parse an optional environment value; explicit configuration takes precedence. */
export function resolveFredCompatibilityConfig(
  explicit: FredCompatibilityConfig | undefined,
  environment: string | undefined,
): FredCompatibilityConfig {
  if (explicit !== undefined || environment === undefined)
    return normalizeFredCompatibility(explicit);
  const value = environment.trim();
  if (value === 'v0.13' || value === 'pr240') return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid(
      'MANIFEST_FRED_COMPATIBILITY must be v0.13, pr240, or a JSON provider URL map.',
    );
  }
  return normalizeFredCompatibility(parsed as FredCompatibilityConfig);
}
