export interface BuildManifestOptions {
  image: string;
  ports: Record<string, Record<string, never>>;
  env?: Record<string, string>;
  command?: string[];
  args?: string[];
  user?: string;
  tmpfs?: string[];
  health_check?: {
    test: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
  stop_grace_period?: string;
  init?: boolean;
  expose?: string[];
  labels?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
}

import {
  DNS_LABEL_RE,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';

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

export type ManifestFormat = 'single' | 'stack';

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly format: ManifestFormat | null;
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

const PORT_KEY_RE = /^([1-9][0-9]{0,4})\/(tcp|udp)$/i;
const EXPOSE_PORT_RE = /^([1-9][0-9]{0,4})$/;
const ENV_NAME_BLOCKED_RE = /^(path|ld_|fred_|docker_)/i;
const TMPFS_BLOCKED = new Set<string>(['/', '/tmp', '/run']);
const TMPFS_BLOCKED_PREFIXES = ['/proc', '/sys', '/dev'];
const HEALTH_CHECK_TYPES = new Set<string>(['CMD', 'CMD-SHELL', 'NONE']);
const DEPENDS_ON_CONDITIONS = new Set<string>([
  'service_started',
  'service_healthy',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validatePort(portStr: string): boolean {
  const n = Number(portStr);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function validateService(
  service: unknown,
  scope: string,
  inStack: boolean,
  errors: string[],
): void {
  if (!isPlainObject(service)) {
    errors.push(`${scope}: must be a JSON object`);
    return;
  }

  // image (required, non-empty string)
  if (!('image' in service)) {
    errors.push(`${scope}.image: required`);
  } else if (typeof service.image !== 'string' || service.image.length === 0) {
    errors.push(`${scope}.image: must be a non-empty string`);
  }

  // unknown keys
  for (const key of Object.keys(service)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`${scope}.${key}: unknown field`);
    }
  }

  // ports
  if ('ports' in service) {
    if (!isPlainObject(service.ports)) {
      errors.push(`${scope}.ports: must be an object`);
    } else {
      for (const key of Object.keys(service.ports)) {
        // PORT_KEY_RE permits up to 5 digits (so 1-99999); the docs and the
        // error message limit ports to 1-65535. validatePort closes the gap
        // so 70000/tcp doesn't silently pass pre-flight.
        const match = key.match(PORT_KEY_RE);
        if (!match || !validatePort(match[1])) {
          errors.push(
            `${scope}.ports["${key}"]: must be in "port/protocol" format with port 1-65535 and protocol tcp|udp`,
          );
        }
      }
    }
  }

  // env: name validation
  if ('env' in service) {
    if (!isPlainObject(service.env)) {
      errors.push(`${scope}.env: must be an object`);
    } else {
      for (const [name, value] of Object.entries(service.env)) {
        if (name.length === 0) {
          errors.push(`${scope}.env: variable name cannot be empty`);
        } else if (name.includes('=') || name.includes(' ')) {
          errors.push(
            `${scope}.env["${name}"]: name cannot contain '=' or NUL`,
          );
        } else if (ENV_NAME_BLOCKED_RE.test(name)) {
          errors.push(
            `${scope}.env["${name}"]: blocked variable name (PATH, LD_*, FRED_*, DOCKER_* are reserved)`,
          );
        }
        if (typeof value !== 'string') {
          errors.push(`${scope}.env["${name}"]: value must be a string`);
        }
      }
    }
  }

  // labels: fred.* prefix is reserved
  if ('labels' in service) {
    if (!isPlainObject(service.labels)) {
      errors.push(`${scope}.labels: must be an object`);
    } else {
      for (const key of Object.keys(service.labels)) {
        if (key.startsWith('fred.')) {
          errors.push(
            `${scope}.labels["${key}"]: reserved prefix 'fred.' is not allowed`,
          );
        }
      }
    }
  }

  // tmpfs
  if ('tmpfs' in service) {
    if (!Array.isArray(service.tmpfs)) {
      errors.push(`${scope}.tmpfs: must be an array of strings`);
    } else {
      if (service.tmpfs.length > 4) {
        errors.push(
          `${scope}.tmpfs: too many mounts (${service.tmpfs.length}), maximum is 4`,
        );
      }
      const seen = new Set<string>();
      for (const path of service.tmpfs) {
        if (typeof path !== 'string') {
          errors.push(`${scope}.tmpfs: entries must be strings`);
          continue;
        }
        if (!path.startsWith('/')) {
          errors.push(`${scope}.tmpfs["${path}"]: must be an absolute path`);
        }
        if (TMPFS_BLOCKED.has(path)) {
          errors.push(
            `${scope}.tmpfs["${path}"]: path is managed by the backend`,
          );
        }
        for (const prefix of TMPFS_BLOCKED_PREFIXES) {
          if (path === prefix || path.startsWith(`${prefix}/`)) {
            errors.push(
              `${scope}.tmpfs["${path}"]: path is under sensitive path ${prefix}`,
            );
          }
        }
        if (seen.has(path)) {
          errors.push(`${scope}.tmpfs["${path}"]: duplicate mount`);
        }
        seen.add(path);
      }
    }
  }

  // user
  if ('user' in service) {
    if (typeof service.user !== 'string') {
      errors.push(`${scope}.user: must be a string`);
    } else if (service.user.length > 0) {
      const u = service.user;
      if (/\s/.test(u)) {
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
          errors.push(`${scope}.health_check.${key}: unknown field`);
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
        if (!isPlainObject(cond)) {
          errors.push(`${scope}.depends_on["${name}"]: must be an object`);
          continue;
        }
        for (const k of Object.keys(cond)) {
          if (k !== 'condition') {
            errors.push(`${scope}.depends_on["${name}"].${k}: unknown field`);
          }
        }
        if (
          typeof cond.condition !== 'string' ||
          !DEPENDS_ON_CONDITIONS.has(cond.condition)
        ) {
          errors.push(
            `${scope}.depends_on["${name}"].condition: must be "service_started" or "service_healthy"`,
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
      const seen = new Set<string>();
      for (const p of service.expose) {
        if (typeof p !== 'string' || !EXPOSE_PORT_RE.test(p)) {
          errors.push(
            `${scope}.expose["${String(p)}"]: must be a port number string (1-65535)`,
          );
        } else if (!validatePort(p)) {
          errors.push(`${scope}.expose["${p}"]: port out of range`);
        }
        if (seen.has(String(p))) {
          errors.push(`${scope}.expose["${String(p)}"]: duplicate`);
        }
        seen.add(String(p));
      }
    }
  }

  // init / stop_grace_period: minimal type checks (range validation is runtime).
  if ('init' in service && typeof service.init !== 'boolean') {
    errors.push(`${scope}.init: must be a boolean`);
  }
  if ('stop_grace_period' in service) {
    const v = service.stop_grace_period;
    if (typeof v !== 'string' && typeof v !== 'number') {
      errors.push(
        `${scope}.stop_grace_period: must be a duration string or integer nanoseconds`,
      );
    }
  }
}

/**
 * Validates a parsed manifest object against the documented Fred rules.
 * Pre-flight only: catches the constraints documented in the public spec
 * (env-name blocklist, label prefix, port format, tmpfs limits, RFC 1123
 * service names, depends_on placement, unknown fields). The provider does
 * the canonical validation server-side; this helper exists so agents can
 * reject obviously-broken manifests before paying for a lease.
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(manifest)) {
    return {
      valid: false,
      errors: ['manifest must be a JSON object'],
      format: null,
    };
  }

  if (isStackManifest(manifest)) {
    // Stack manifest — only `services` is allowed at the top level.
    for (const key of Object.keys(manifest)) {
      if (key !== 'services') {
        errors.push(`${key}: unknown top-level field for stack manifest`);
      }
    }
    const serviceNames = Object.keys(manifest.services);
    if (serviceNames.length === 0) {
      errors.push('services: at least one service is required');
    }
    for (const name of serviceNames) {
      if (!validateServiceName(name)) {
        errors.push(
          `services["${name}"]: must be a valid RFC 1123 DNS label (1-63 chars, lowercase alphanumeric + hyphens)`,
        );
      }
      validateService(
        manifest.services[name],
        `services["${name}"]`,
        true,
        errors,
      );
    }
    // Cross-service: depends_on must only reference defined services and not
    // self. Set lookup keeps the cross-check linear in total dep edges
    // instead of O(services * deps * services).
    const serviceNameSet = new Set(serviceNames);
    for (const [name, svc] of Object.entries(manifest.services)) {
      if (isPlainObject(svc) && isPlainObject(svc.depends_on)) {
        for (const dep of Object.keys(svc.depends_on)) {
          if (dep === name) {
            errors.push(
              `services["${name}"].depends_on["${dep}"]: a service cannot depend on itself`,
            );
          } else if (!serviceNameSet.has(dep)) {
            errors.push(
              `services["${name}"].depends_on["${dep}"]: references undefined service`,
            );
          }
        }
      }
    }
    return {
      valid: errors.length === 0,
      errors,
      format: 'stack',
    };
  }

  // Single-service manifest.
  validateService(manifest, '', false, errors);
  return {
    valid: errors.length === 0,
    errors,
    format: 'single',
  };
}
