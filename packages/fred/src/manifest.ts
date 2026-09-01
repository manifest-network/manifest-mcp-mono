import type {
  BuildManifestOptions,
  ManifestFormat,
  ManifestValidationResult,
} from '@manifest-network/manifest-mcp-core';

export type { BuildManifestOptions, ManifestFormat, ManifestValidationResult };

import {
  DNS_LABEL_RE,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { FRED_MANIFEST_LIMITS } from './generated/fred-manifest-limits.js';

const MAX_NAME_LENGTH = 32;

export function deriveAppNameFromImage(image: string): string {
  // Strip registry prefix (everything before the last /)
  const lastSlash = image.lastIndexOf('/');
  let name = lastSlash >= 0 ? image.slice(lastSlash + 1) : image;

  // Strip digest (@sha256:...)
  const atIdx = name.indexOf('@');
  if (atIdx >= 0) {
    name = name.slice(0, atIdx);
  }

  // Strip tag unconditionally
  const colonIdx = name.indexOf(':');
  if (colonIdx >= 0) {
    name = name.slice(0, colonIdx);
  }

  // Normalize: lowercase, replace non-alphanumeric with hyphens
  name = name.toLowerCase().replace(/[^a-z0-9]/g, '-');

  // Collapse consecutive hyphens
  name = name.replace(/-{2,}/g, '-');

  // Trim leading/trailing hyphens
  name = name.replace(/^-+|-+$/g, '');

  // Truncate
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH).replace(/-+$/, '');
  }

  return name;
}

export function validateServiceName(name: string): boolean {
  return DNS_LABEL_RE.test(name);
}

export function buildManifest(
  opts: BuildManifestOptions,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    image: opts.image,
    ports: opts.ports,
  };
  if (opts.env) manifest.env = opts.env;
  if (opts.command) manifest.command = opts.command;
  if (opts.args) manifest.args = opts.args;
  if (opts.user) manifest.user = opts.user;
  if (opts.tmpfs) manifest.tmpfs = opts.tmpfs;
  if (opts.health_check) manifest.health_check = opts.health_check;
  if (opts.stop_grace_period)
    manifest.stop_grace_period = opts.stop_grace_period;
  if (opts.init !== undefined) manifest.init = opts.init;
  if (opts.expose) manifest.expose = opts.expose;
  if (opts.labels) manifest.labels = opts.labels;
  if (opts.depends_on) manifest.depends_on = opts.depends_on;
  return manifest;
}

const VALID_PROTOCOLS = new Set(['tcp', 'udp']);

export function normalizePorts(
  port: string,
): Record<string, Record<string, never>> {
  const result: Record<string, Record<string, never>> = {};
  for (const raw of port.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const slashIdx = trimmed.indexOf('/');
    const portStr = slashIdx >= 0 ? trimmed.slice(0, slashIdx) : trimmed;
    const protocol = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : 'tcp';
    const portNum = parseInt(portStr, 10);
    if (
      Number.isNaN(portNum) ||
      portNum < 1 ||
      portNum > 65535 ||
      String(portNum) !== portStr
    ) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `Invalid port: "${portStr}". Port must be a number between 1 and 65535.`,
      );
    }
    if (!VALID_PROTOCOLS.has(protocol)) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `Invalid protocol: "${protocol}". Must be "tcp" or "udp".`,
      );
    }
    result[`${portNum}/${protocol}`] = {};
  }
  return result;
}

export function buildStackManifest(opts: {
  services: Record<string, BuildManifestOptions>;
}): { services: Record<string, unknown> } {
  const stack: Record<string, unknown> = {};
  for (const [name, serviceOpts] of Object.entries(opts.services)) {
    stack[name] = buildManifest(serviceOpts);
  }
  return { services: stack };
}

const CARRY_FORWARD_KEYS = [
  'user',
  'tmpfs',
  'command',
  'args',
  'health_check',
  'stop_grace_period',
  'init',
  'expose',
  'depends_on',
] as const;

export function mergeManifest(
  newManifest: Record<string, unknown>,
  oldManifestJson: string,
): Record<string, unknown> {
  let old: Record<string, unknown>;
  try {
    const parsed = JSON.parse(oldManifestJson);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'existing_manifest must be a JSON object',
      );
    }
    old = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `existing_manifest contains invalid JSON: ${err.message}`,
      );
    }
    throw err;
  }

  const merged: Record<string, unknown> = { ...newManifest };

  // env: old defaults, new overrides
  if (old.env || merged.env) {
    merged.env = {
      ...(old.env as Record<string, string> | undefined),
      ...(merged.env as Record<string, string> | undefined),
    };
  }

  // ports: union
  if (old.ports || merged.ports) {
    merged.ports = {
      ...(old.ports as Record<string, unknown> | undefined),
      ...(merged.ports as Record<string, unknown> | undefined),
    };
  }

  // labels: old defaults, new overrides
  if (old.labels || merged.labels) {
    merged.labels = {
      ...(old.labels as Record<string, string> | undefined),
      ...(merged.labels as Record<string, string> | undefined),
    };
  }

  // Carry forward from old if not present in new
  for (const key of CARRY_FORWARD_KEYS) {
    if (!(key in merged) && key in old) {
      merged[key] = old[key];
    }
  }

  return merged;
}

export function isStackManifest(
  manifest: unknown,
): manifest is { services: Record<string, Record<string, unknown>> } {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest)
  ) {
    return false;
  }
  const services = (manifest as Record<string, unknown>).services;
  if (
    services === null ||
    typeof services !== 'object' ||
    Array.isArray(services)
  ) {
    return false;
  }
  const entries = Object.values(services as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    (v) =>
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      'image' in (v as Record<string, unknown>),
  );
}

export function parseStackManifest(json: string): {
  services: Record<string, Record<string, unknown>>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `Stack manifest contains invalid JSON: ${err.message}`,
      );
    }
    throw err;
  }
  if (!isStackManifest(parsed)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'Not a valid stack manifest: expected { services: { ... } } where each service has an "image" key',
    );
  }
  return parsed;
}

export function getServiceNames(manifest: unknown): string[] {
  if (!isStackManifest(manifest)) return [];
  return Object.keys(manifest.services);
}

/**
 * Computes the lowercase hex SHA-256 of the manifest JSON. The result must
 * match the `meta_hash` recorded on-chain — Fred rejects uploads whose body
 * hash does not match. Callers are responsible for serializing exactly the
 * bytes that will be uploaded.
 */
export async function metaHashHex(manifestJson: string): Promise<string> {
  const encoded = new TextEncoder().encode(manifestJson);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = new Uint8Array(hashBuffer);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const ALLOWED_TOP_LEVEL_KEYS = new Set<string>([
  'image',
  'ports',
  'env',
  'command',
  'args',
  'labels',
  'health_check',
  'tmpfs',
  'user',
  'depends_on',
  'stop_grace_period',
  'init',
  'expose',
]);

const HEALTH_CHECK_KEYS = new Set<string>([
  'test',
  'interval',
  'timeout',
  'retries',
  'start_period',
]);

const ENV_NAME_BLOCKED_PREFIX_RE = /^(ld_|fred_|docker_)/i;
const RESERVED_LABEL_PREFIX_RE = /^(fred|traefik)\./i;
const PORT_CONFIG_KEYS = new Set<string>(['host_port', 'ingress']);
const TMPFS_BLOCKED = new Set<string>(['/', '/tmp', '/run']);
const TMPFS_BLOCKED_PREFIXES = ['/proc', '/sys', '/dev'];
const HEALTH_CHECK_TYPES = new Set<string>(['CMD', 'CMD-SHELL', 'NONE']);
const DEPENDS_ON_CONDITIONS = new Set<string>([
  'service_started',
  'service_healthy',
]);

// Fred's Go-only allocation caps are generated from the manifest.go pinned by
// the submodule gitlink. The schema sync gate regenerates and checks this file,
// so a Fred limit change cannot be hidden behind an unchanged JSON Schema.
const {
  maxTmpfsMounts: MAX_TMPFS_MOUNTS,
  maxPorts: MAX_PORTS,
  maxExposePorts: MAX_EXPOSE_PORTS,
  maxEnvVars: MAX_ENV_VARS,
  maxLabels: MAX_LABELS,
  dependsOnMaxDepth: DEPENDS_ON_MAX_DEPTH,
  minStopGracePeriodNanoseconds: MIN_STOP_GRACE_PERIOD_NANOSECONDS,
  maxStopGracePeriodNanoseconds: MAX_STOP_GRACE_PERIOD_NANOSECONDS,
} = FRED_MANIFEST_LIMITS;

const DURATION_UNIT_NANOSECONDS: Readonly<Record<string, bigint>> = {
  ns: 1n,
  us: 1_000n,
  µs: 1_000n,
  μs: 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};
const MAX_INT64 = (1n << 63n) - 1n;
const MIN_INT64_MAGNITUDE = 1n << 63n;
const MAX_REPORTED_VALIDATION_ERRORS = 16;
const MAX_VALIDATION_ERROR_CHARACTERS = 240;
const MAX_DIAGNOSTIC_VALUE_CHARACTERS = 96;

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.getOwnPropertyDescriptor(object, key) !== undefined;
}

class BoundedValidationErrors extends Array<string> {
  omitted = 0;

  override push(...messages: string[]): number {
    for (const message of messages) {
      if (this.length >= MAX_REPORTED_VALIDATION_ERRORS - 1) {
        this.omitted++;
        continue;
      }
      const characters = Array.from(message);
      super.push(
        characters.length <= MAX_VALIDATION_ERROR_CHARACTERS
          ? message
          : `${characters.slice(0, MAX_VALIDATION_ERROR_CHARACTERS / 2 - 1).join('')}…${characters.slice(-(MAX_VALIDATION_ERROR_CHARACTERS / 2)).join('')}`,
      );
    }
    return this.length;
  }

  reported(): string[] {
    return this.omitted === 0
      ? [...this]
      : [...this, `… ${this.omitted} additional validation errors omitted`];
  }
}

function truncateDiagnosticValue(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= MAX_DIAGNOSTIC_VALUE_CHARACTERS) return value;
  const side = MAX_DIAGNOSTIC_VALUE_CHARACTERS / 2;
  return `${characters.slice(0, side - 1).join('')}…${characters.slice(-side).join('')}`;
}

function diagnosticValue(value: unknown): string {
  return JSON.stringify(truncateDiagnosticValue(String(value)));
}

function mapKeyPath(base: string, key: unknown): string {
  return `${base}[${diagnosticValue(key)}]`;
}

function propertyPath(base: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${base}.${key}`
    : mapKeyPath(base, key);
}

function cleanPosixPath(value: string): string {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (absolute) return `/${parts.join('/')}`;
  return parts.join('/') || '.';
}

function parseGoDurationNanoseconds(value: string): bigint | undefined {
  if (value.length === 0) return undefined;

  let remaining = value;
  let negative = false;
  if (remaining[0] === '+' || remaining[0] === '-') {
    negative = remaining[0] === '-';
    remaining = remaining.slice(1);
  }
  if (remaining === '0') return 0n;
  if (remaining.length === 0) return undefined;

  // Mirror time.ParseDuration's decimal grammar, but keep the arithmetic in
  // integers. Converting the whole decimal through Number first rounds values
  // near the 1s/120s admission bounds differently from Go.
  const partRe = /(\d*)(?:\.(\d*))?(ns|us|µs|μs|ms|s|m|h)/gy;
  let offset = 0;
  let total = 0n;
  while (offset < remaining.length) {
    partRe.lastIndex = offset;
    const match = partRe.exec(remaining);
    if (!match || match.index !== offset) return undefined;
    const whole = match[1];
    const fraction = match[2];
    if (whole.length === 0 && (fraction === undefined || fraction.length === 0))
      return undefined;

    const unit = DURATION_UNIT_NANOSECONDS[match[3]];
    const significantWhole = whole.replace(/^0+/, '');
    if (significantWhole.length > 19) return undefined;
    let component =
      significantWhole.length === 0 ? 0n : BigInt(significantWhole) * unit;
    if (fraction !== undefined && fraction.length > 0) {
      // Go's leadingFraction stops accumulating once its uint64 would
      // overflow. Reproduce that bounded prefix so an input near the payload
      // cap cannot force a giant BigInt allocation.
      let numerator = 0n;
      let scale = 1;
      let overflow = false;
      for (const digit of fraction) {
        if (overflow) continue;
        if (numerator > MAX_INT64 / 10n) {
          overflow = true;
          continue;
        }
        const next = numerator * 10n + BigInt(digit);
        if (next > MIN_INT64_MAGNITUDE) {
          overflow = true;
          continue;
        }
        numerator = next;
        scale *= 10;
      }
      if (numerator > 0n) {
        // time.ParseDuration deliberately performs this fractional step in
        // float64. Keep the whole component in bigint, but mirror that final
        // operation so nanosecond truncation agrees with Go at its rounding
        // boundaries.
        const fractionalNanoseconds = Math.trunc(
          Number(numerator) * (Number(unit) / scale),
        );
        component += BigInt(fractionalNanoseconds);
      }
    }
    total += component;
    if (total > MIN_INT64_MAGNITUDE) return undefined;
    offset = partRe.lastIndex;
  }

  if (!negative && total > MAX_INT64) return undefined;
  return negative ? -total : total;
}

function durationValueNanoseconds(value: unknown): bigint | undefined {
  if (typeof value === 'string') return parseGoDurationNanoseconds(value);
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  const nanoseconds = BigInt(value);
  if (nanoseconds < -MIN_INT64_MAGNITUDE || nanoseconds > MAX_INT64)
    return undefined;
  return nanoseconds;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function normalizeStringArray(value: unknown): unknown {
  if (value === null) return [];
  if (!Array.isArray(value)) return value;
  return value.map((entry) => (entry === null ? '' : entry));
}

function normalizeStringMap(value: unknown): unknown {
  if (value === null) return {};
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      entry === null ? '' : entry,
    ]),
  );
}

/** Model encoding/json's null-to-zero-value behavior before validating. */
function normalizeServiceForGo(service: unknown): unknown {
  if (!isPlainObject(service)) return service;
  const normalized: Record<string, unknown> = { ...service };

  for (const field of ['image', 'user'] as const) {
    if (normalized[field] === null) normalized[field] = '';
  }
  for (const field of ['command', 'args', 'tmpfs', 'expose'] as const) {
    if (field in normalized)
      normalized[field] = normalizeStringArray(normalized[field]);
  }
  for (const field of ['env', 'labels'] as const) {
    if (field in normalized)
      normalized[field] = normalizeStringMap(normalized[field]);
  }

  if ('ports' in normalized) {
    if (normalized.ports === null) {
      normalized.ports = {};
    } else if (isPlainObject(normalized.ports)) {
      normalized.ports = Object.fromEntries(
        Object.entries(normalized.ports).map(([key, config]) => {
          if (config === null) return [key, {}];
          if (!isPlainObject(config)) return [key, config];
          const decoded = { ...config };
          if (decoded.host_port === null) decoded.host_port = 0;
          if (decoded.ingress === null) decoded.ingress = false;
          return [key, decoded];
        }),
      );
    }
  }

  if ('health_check' in normalized) {
    if (normalized.health_check === null) {
      delete normalized.health_check;
    } else if (isPlainObject(normalized.health_check)) {
      const healthCheck = { ...normalized.health_check };
      if ('test' in healthCheck)
        healthCheck.test = normalizeStringArray(healthCheck.test);
      if (healthCheck.retries === null) healthCheck.retries = 0;
      normalized.health_check = healthCheck;
    }
  }

  if ('depends_on' in normalized) {
    if (normalized.depends_on === null) {
      normalized.depends_on = {};
    } else if (isPlainObject(normalized.depends_on)) {
      normalized.depends_on = Object.fromEntries(
        Object.entries(normalized.depends_on).map(([key, condition]) => {
          if (condition === null) return [key, {}];
          if (!isPlainObject(condition)) return [key, condition];
          const decoded = { ...condition };
          if (decoded.condition === null) decoded.condition = '';
          return [key, decoded];
        }),
      );
    }
  }

  if (normalized.stop_grace_period === null)
    delete normalized.stop_grace_period;
  if (normalized.init === null) delete normalized.init;
  return normalized;
}

function normalizeManifestForGo(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  if (!hasOwn(manifest, 'services'))
    return normalizeServiceForGo(manifest) as Record<string, unknown>;
  if (!isPlainObject(manifest.services)) return { ...manifest };
  return {
    ...manifest,
    services: Object.fromEntries(
      Object.entries(manifest.services).map(([name, service]) => [
        name,
        normalizeServiceForGo(service),
      ]),
    ),
  };
}

function parseGoDecimalInteger(value: string): bigint | undefined {
  if (!/^[+-]?\d+$/.test(value)) return undefined;
  const negative = value[0] === '-';
  const digits = value[0] === '-' || value[0] === '+' ? value.slice(1) : value;
  const significant = digits.replace(/^0+/, '') || '0';
  // strconv.Atoi is machine-int bounded. Avoid constructing an arbitrarily
  // large bigint from a tenant-controlled port key while retaining its
  // accepted signed/leading-zero spellings.
  if (significant.length > 19) return undefined;
  const parsed = BigInt(significant);
  return negative ? -parsed : parsed;
}

function parsePortSpec(
  spec: string,
): { readonly port: bigint; readonly protocol: string } | undefined {
  const parts = spec.split('/');
  if (parts.length !== 2) return undefined;
  const port = parseGoDecimalInteger(parts[0]);
  const protocol = parts[1].toLowerCase();
  if (
    port === undefined ||
    port < 1n ||
    port > 65_535n ||
    (protocol !== 'tcp' && protocol !== 'udp')
  )
    return undefined;
  return { port, protocol };
}

function validateService(
  service: unknown,
  scope: string,
  inStack: boolean,
  errors: BoundedValidationErrors,
): void {
  if (!isPlainObject(service)) {
    errors.push(`${scope}: must be a JSON object`);
    return;
  }

  for (const field of ['command', 'args'] as const) {
    if (!(field in service)) continue;
    const value = service[field];
    if (!Array.isArray(value)) {
      errors.push(`${scope}.${field}: must be an array of strings`);
    } else if (!value.every((entry) => typeof entry === 'string')) {
      errors.push(`${scope}.${field}: entries must be strings`);
    }
  }

  // image (required, non-empty string)
  if (!('image' in service)) {
    errors.push(`${scope}.image: required`);
  } else if (typeof service.image !== 'string' || service.image.length === 0) {
    errors.push(`${scope}.image: must be a non-empty string`);
  }

  // unknown keys + case-folded collisions (Go encoding/json matches fields
  // case-insensitively; V8 keeps `image` and `IMAGE` as two keys).
  const seenLower = new Map<string, string>();
  for (const key of Object.keys(service)) {
    const lower = key.toLowerCase();
    const prev = seenLower.get(lower);
    if (prev !== undefined) {
      errors.push(
        `${scope}: keys ${diagnosticValue(prev)} and ${diagnosticValue(key)} collide case-insensitively (the provider matches fields case-insensitively)`,
      );
    } else {
      seenLower.set(lower, key);
    }
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`${propertyPath(scope, key)}: unknown field`);
    }
  }

  // ports
  if ('ports' in service) {
    if (!isPlainObject(service.ports)) {
      errors.push(`${scope}.ports: must be an object`);
    } else {
      const portEntries = Object.entries(service.ports);
      if (portEntries.length > MAX_PORTS) {
        errors.push(
          `${scope}.ports: too many entries (${portEntries.length}), maximum is ${MAX_PORTS}`,
        );
      }
      let ingressPort: string | undefined;
      for (const [key, config] of portEntries) {
        const portPath = mapKeyPath(`${scope}.ports`, key);
        const parsedPort = parsePortSpec(key);
        if (!parsedPort) {
          errors.push(
            `${portPath}: must be in "port/protocol" format with port 1-65535 and protocol tcp|udp`,
          );
        }
        if (!isPlainObject(config)) {
          errors.push(`${portPath}: must be an object`);
          continue;
        }
        for (const configKey of Object.keys(config)) {
          if (!PORT_CONFIG_KEYS.has(configKey)) {
            errors.push(`${propertyPath(portPath, configKey)}: unknown field`);
          }
        }
        if ('host_port' in config) {
          if (
            typeof config.host_port !== 'number' ||
            !Number.isInteger(config.host_port) ||
            config.host_port < 0
          ) {
            errors.push(
              `${portPath}.host_port: must be the integer 0 when provided`,
            );
          } else if (config.host_port > 0) {
            errors.push(
              `${portPath}.host_port: fixed host ports are not permitted; omit host_port so Fred assigns one dynamically`,
            );
          }
        }
        if ('ingress' in config) {
          if (typeof config.ingress !== 'boolean') {
            errors.push(`${portPath}.ingress: must be a boolean`);
          } else if (config.ingress) {
            if (parsedPort?.protocol !== 'tcp') {
              errors.push(`${portPath}.ingress: requires TCP protocol`);
            }
            if (ingressPort !== undefined) {
              errors.push(
                `${portPath}.ingress: at most one port may set ingress=true (already set on ${diagnosticValue(ingressPort)})`,
              );
            } else {
              ingressPort = key;
            }
          }
        }
      }
    }
  }

  // env: name validation
  if ('env' in service) {
    if (!isPlainObject(service.env)) {
      errors.push(`${scope}.env: must be an object`);
    } else {
      const envEntries = Object.entries(service.env);
      if (envEntries.length > MAX_ENV_VARS) {
        errors.push(
          `${scope}.env: too many variables (${envEntries.length}), maximum is ${MAX_ENV_VARS}`,
        );
      }
      for (const [name, value] of envEntries) {
        const envPath = mapKeyPath(`${scope}.env`, name);
        if (name.length === 0) {
          errors.push(`${scope}.env: variable name cannot be empty`);
        } else if (name.includes('=') || name.includes('\0')) {
          errors.push(`${envPath}: name cannot contain '=' or NUL`);
        } else if (
          name.toUpperCase() === 'PATH' ||
          ENV_NAME_BLOCKED_PREFIX_RE.test(name)
        ) {
          errors.push(
            `${envPath}: blocked variable name (PATH, LD_*, FRED_*, DOCKER_* are reserved)`,
          );
        }
        if (typeof value !== 'string') {
          errors.push(`${envPath}: value must be a string`);
        }
      }
    }
  }

  // labels: fred.* and traefik.* prefixes are reserved case-insensitively.
  if ('labels' in service) {
    if (!isPlainObject(service.labels)) {
      errors.push(`${scope}.labels: must be an object`);
    } else {
      const labelKeys = Object.keys(service.labels);
      if (labelKeys.length > MAX_LABELS) {
        errors.push(
          `${scope}.labels: too many labels (${labelKeys.length}), maximum is ${MAX_LABELS}`,
        );
      }
      for (const key of labelKeys) {
        const labelPath = mapKeyPath(`${scope}.labels`, key);
        const reserved = key.match(RESERVED_LABEL_PREFIX_RE);
        if (reserved) {
          const prefix = `${reserved[1].toLowerCase()}.`;
          errors.push(
            `${labelPath}: reserved prefix '${prefix}' is not allowed`,
          );
        }
        if (typeof service.labels[key] !== 'string') {
          errors.push(`${labelPath}: value must be a string`);
        }
      }
    }
  }

  // tmpfs
  if ('tmpfs' in service) {
    if (!Array.isArray(service.tmpfs)) {
      errors.push(`${scope}.tmpfs: must be an array of strings`);
    } else {
      if (service.tmpfs.length > MAX_TMPFS_MOUNTS) {
        errors.push(
          `${scope}.tmpfs: too many mounts (${service.tmpfs.length}), maximum is ${MAX_TMPFS_MOUNTS}`,
        );
      }
      const seen = new Set<string>();
      for (const rawPath of service.tmpfs) {
        if (typeof rawPath !== 'string') {
          errors.push(`${scope}.tmpfs: entries must be strings`);
          continue;
        }
        const tmpfsPath = mapKeyPath(`${scope}.tmpfs`, rawPath);
        if (!rawPath.startsWith('/')) {
          errors.push(`${tmpfsPath}: must be an absolute path`);
          continue;
        }
        // Fred applies path.Clean before its blocked-path and duplicate checks.
        // Mirror that normalization so trailing slashes and `..` cannot hide a
        // backend-managed/sensitive path or a duplicate mount.
        const cleanedPath = cleanPosixPath(rawPath);
        if (TMPFS_BLOCKED.has(cleanedPath)) {
          errors.push(
            `${tmpfsPath}: resolves to backend-managed path ${diagnosticValue(cleanedPath)}`,
          );
        }
        for (const prefix of TMPFS_BLOCKED_PREFIXES) {
          if (cleanedPath === prefix || cleanedPath.startsWith(`${prefix}/`)) {
            errors.push(
              `${tmpfsPath}: resolves under sensitive path ${prefix}`,
            );
          }
        }
        if (seen.has(cleanedPath)) {
          errors.push(
            `${tmpfsPath}: duplicate normalized mount ${diagnosticValue(cleanedPath)}`,
          );
        }
        seen.add(cleanedPath);
      }
    }
  }

  // user
  if ('user' in service) {
    if (typeof service.user !== 'string') {
      errors.push(`${scope}.user: must be a string`);
    } else if (service.user.length > 0) {
      const u = service.user;
      if (/[ \t\n\r]/.test(u)) {
        errors.push(`${scope}.user: cannot contain whitespace`);
      } else {
        const colon = u.indexOf(':');
        if (colon === 0 || colon === u.length - 1) {
          errors.push(`${scope}.user: user/group parts cannot be empty`);
        }
      }
    }
  }

  // health_check
  if ('health_check' in service) {
    if (!isPlainObject(service.health_check)) {
      errors.push(`${scope}.health_check: must be an object`);
    } else {
      const hc = service.health_check;
      for (const key of Object.keys(hc)) {
        if (!HEALTH_CHECK_KEYS.has(key)) {
          errors.push(
            `${propertyPath(`${scope}.health_check`, key)}: unknown field`,
          );
        }
      }
      if (!('test' in hc)) {
        errors.push(`${scope}.health_check.test: required`);
      } else if (
        !Array.isArray(hc.test) ||
        hc.test.length === 0 ||
        !hc.test.every((s) => typeof s === 'string')
      ) {
        errors.push(`${scope}.health_check.test: must be a non-empty string[]`);
      } else {
        const head = hc.test[0];
        if (!HEALTH_CHECK_TYPES.has(head)) {
          errors.push(
            `${scope}.health_check.test[0]: must be CMD, CMD-SHELL, or NONE`,
          );
        } else if (head !== 'NONE' && hc.test.length < 2) {
          errors.push(
            `${scope}.health_check.test: ${head} requires at least one argument after the type`,
          );
        } else if (head === 'NONE' && hc.test.length > 1) {
          errors.push(
            `${scope}.health_check.test: NONE accepts no further arguments`,
          );
        }
      }
      if (
        'retries' in hc &&
        (typeof hc.retries !== 'number' ||
          !Number.isInteger(hc.retries) ||
          hc.retries < 0)
      ) {
        errors.push(
          `${scope}.health_check.retries: must be a non-negative integer`,
        );
      }
      for (const field of ['interval', 'timeout', 'start_period'] as const) {
        if (field in hc && durationValueNanoseconds(hc[field]) === undefined) {
          errors.push(
            `${scope}.health_check.${field}: must be a valid Go duration string or integer nanoseconds`,
          );
        }
      }
    }
  }

  // depends_on: only valid in stack
  if ('depends_on' in service) {
    if (!isPlainObject(service.depends_on)) {
      errors.push(`${scope}.depends_on: must be an object`);
    } else {
      const entries = Object.entries(service.depends_on);
      if (entries.length > 0 && !inStack) {
        errors.push(
          `${scope}.depends_on: only allowed inside a stack manifest (services map)`,
        );
      }
      for (const [name, cond] of entries) {
        const dependencyPath = mapKeyPath(`${scope}.depends_on`, name);
        if (!isPlainObject(cond)) {
          errors.push(`${dependencyPath}: must be an object`);
          continue;
        }
        for (const k of Object.keys(cond)) {
          if (k !== 'condition') {
            errors.push(`${propertyPath(dependencyPath, k)}: unknown field`);
          }
        }
        if (
          typeof cond.condition !== 'string' ||
          !DEPENDS_ON_CONDITIONS.has(cond.condition)
        ) {
          errors.push(
            `${dependencyPath}.condition: must be "service_started" or "service_healthy"`,
          );
        }
      }
    }
  }

  // expose
  if ('expose' in service) {
    if (!Array.isArray(service.expose)) {
      errors.push(`${scope}.expose: must be an array of port strings`);
    } else {
      if (service.expose.length > MAX_EXPOSE_PORTS) {
        errors.push(
          `${scope}.expose: too many ports (${service.expose.length}), maximum is ${MAX_EXPOSE_PORTS}`,
        );
      }
      const seen = new Set<string>();
      for (const p of service.expose) {
        const exposePath = mapKeyPath(`${scope}.expose`, p);
        const port =
          typeof p === 'string' ? parseGoDecimalInteger(p) : undefined;
        if (port === undefined) {
          errors.push(`${exposePath}: must be a port number string (1-65535)`);
        } else if (port < 1n || port > 65_535n) {
          errors.push(`${exposePath}: port out of range`);
        }
        if (seen.has(String(p))) {
          errors.push(`${exposePath}: duplicate`);
        }
        seen.add(String(p));
      }
    }
  }

  // init / stop_grace_period
  if ('init' in service && typeof service.init !== 'boolean') {
    errors.push(`${scope}.init: must be a boolean`);
  }
  if ('stop_grace_period' in service) {
    const v = service.stop_grace_period;
    const nanoseconds = durationValueNanoseconds(v);
    if (nanoseconds === undefined) {
      errors.push(
        `${scope}.stop_grace_period: must be a valid Go duration string or integer nanoseconds`,
      );
    } else if (nanoseconds < BigInt(MIN_STOP_GRACE_PERIOD_NANOSECONDS)) {
      errors.push(`${scope}.stop_grace_period: must be at least 1s`);
    } else if (nanoseconds > BigInt(MAX_STOP_GRACE_PERIOD_NANOSECONDS)) {
      errors.push(`${scope}.stop_grace_period: must be at most 120s`);
    }
  }
}

function hasActiveHealthCheck(service: unknown): boolean {
  if (!isPlainObject(service) || !isPlainObject(service.health_check))
    return false;
  const test = service.health_check.test;
  return Array.isArray(test) && test.length > 0 && test[0] !== 'NONE';
}

function validateStackDependencies(
  services: Record<string, unknown>,
  errors: BoundedValidationErrors,
): void {
  const serviceNames = Object.keys(services);
  const serviceNameSet = new Set(serviceNames);

  for (const [name, service] of Object.entries(services)) {
    if (!isPlainObject(service) || !isPlainObject(service.depends_on)) continue;
    for (const [dependency, condition] of Object.entries(service.depends_on)) {
      const path = mapKeyPath(
        `${mapKeyPath('manifest.services', name)}.depends_on`,
        dependency,
      );
      if (dependency === name) {
        errors.push(`${path}: a service cannot depend on itself`);
        continue;
      }
      if (!serviceNameSet.has(dependency)) {
        errors.push(`${path}: references undefined service`);
        continue;
      }
      if (
        isPlainObject(condition) &&
        condition.condition === 'service_healthy' &&
        !hasActiveHealthCheck(services[dependency])
      ) {
        errors.push(
          `${path}: service_healthy requires ${diagnosticValue(dependency)} to have an active health_check`,
        );
      }
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const visit = (name: string, depth: number): boolean => {
    if (depth > DEPENDS_ON_MAX_DEPTH) {
      errors.push(
        `manifest.depends_on: dependency chain exceeds maximum depth of ${DEPENDS_ON_MAX_DEPTH}`,
      );
      return false;
    }
    color.set(name, GRAY);
    const service = services[name];
    if (isPlainObject(service) && isPlainObject(service.depends_on)) {
      for (const dependency of Object.keys(service.depends_on)) {
        if (!serviceNameSet.has(dependency) || dependency === name) continue;
        const dependencyColor = color.get(dependency) ?? WHITE;
        if (dependencyColor === GRAY) {
          errors.push(
            `manifest.depends_on: cycle detected involving service ${diagnosticValue(dependency)}`,
          );
          return false;
        }
        if (dependencyColor === WHITE && !visit(dependency, depth + 1))
          return false;
      }
    }
    color.set(name, BLACK);
    return true;
  };

  for (const name of serviceNames) {
    if ((color.get(name) ?? WHITE) === WHITE && !visit(name, 0)) return;
  }
}

/**
 * Validates a parsed manifest object against Fred's Go decoding and semantic
 * admission rules. The published schema remains a generated drift/test
 * artifact, but is deliberately not authoritative at runtime because it is
 * narrower than Fred's decoder. Diagnostics are bounded before they can enter
 * an MCP error response or model context.
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors = new BoundedValidationErrors();

  if (!isPlainObject(manifest)) {
    return {
      valid: false,
      errors: ['manifest must be a JSON object'],
      format: null,
    };
  }

  const decodedManifest = normalizeManifestForGo(manifest);
  const stackIntent = hasOwn(decodedManifest, 'services');

  if (stackIntent) {
    // Stack manifest — only `services` is allowed at the top level.
    for (const key of Object.keys(decodedManifest)) {
      if (key !== 'services') {
        errors.push(
          `${propertyPath('manifest', key)}: unknown top-level field for stack manifest`,
        );
      }
    }
    if (!isPlainObject(decodedManifest.services)) {
      errors.push('manifest.services: must be a JSON object');
    } else {
      const serviceNames = Object.keys(decodedManifest.services);
      if (serviceNames.length === 0) {
        errors.push('manifest.services: at least one service is required');
      }
      for (const name of serviceNames) {
        const servicePath = mapKeyPath('manifest.services', name);
        if (!validateServiceName(name)) {
          errors.push(
            `${servicePath}: must be a valid RFC 1123 DNS label (1-63 chars, lowercase alphanumeric + hyphens)`,
          );
        }
        validateService(
          decodedManifest.services[name],
          servicePath,
          true,
          errors,
        );
      }
      validateStackDependencies(decodedManifest.services, errors);
    }
    const reportedErrors = errors.reported();
    return {
      valid: reportedErrors.length === 0,
      errors: reportedErrors,
      format: 'stack',
    };
  }

  // Single-service manifest.
  validateService(decodedManifest, 'manifest', false, errors);
  const reportedErrors = errors.reported();
  return {
    valid: reportedErrors.length === 0,
    errors: reportedErrors,
    format: 'single',
  };
}
