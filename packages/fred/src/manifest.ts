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
