import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  type BuildManifestOptions,
  buildManifest,
  buildStackManifest,
  isStackManifest,
  type ManifestFormat,
  metaHashHex,
  validateManifest,
} from '../manifest.js';

export interface ManifestPreviewServiceInput {
  readonly image: string;
  readonly ports?: Record<string, Record<string, never>>;
  readonly env?: Record<string, string>;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly user?: string;
  readonly tmpfs?: readonly string[];
  readonly health_check?: BuildManifestOptions['health_check'];
  readonly stop_grace_period?: string;
  readonly depends_on?: Record<string, { condition: string }>;
  readonly expose?: readonly string[];
  readonly labels?: Record<string, string>;
}

export interface BuildManifestPreviewInput {
  /** Raw manifest JSON. Mutually exclusive with the structured fields below. */
  readonly manifest?: string;
  /** Single-service: image + port[+...]. Mutually exclusive with `services` and `manifest`. */
  readonly image?: string;
  readonly port?: number;
  readonly env?: Record<string, string>;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly user?: string;
  readonly tmpfs?: readonly string[];
  readonly health_check?: BuildManifestOptions['health_check'];
  readonly stop_grace_period?: string;
  readonly init?: boolean;
  readonly expose?: readonly string[];
  readonly labels?: Record<string, string>;
  readonly depends_on?: Record<string, { condition: string }>;
  /** Stack manifest. Mutually exclusive with `image`/`port` and `manifest`. */
  readonly services?: Record<string, ManifestPreviewServiceInput>;
}

export interface BuildManifestPreviewResult {
  readonly manifest_json: string;
  readonly manifest: Record<string, unknown>;
  readonly format: ManifestFormat;
  readonly meta_hash_hex: string;
  readonly validation: {
    readonly valid: boolean;
    readonly errors: readonly string[];
  };
}

const STRUCTURED_FIELDS: readonly (keyof BuildManifestPreviewInput)[] = [
  'image',
  'port',
  'env',
  'command',
  'args',
  'user',
  'tmpfs',
  'health_check',
  'stop_grace_period',
  'init',
  'expose',
  'labels',
  'depends_on',
  'services',
];

function hasAnyStructuredField(input: BuildManifestPreviewInput): boolean {
  return STRUCTURED_FIELDS.some((k) => input[k] !== undefined);
}

function toBuildOptions(
  svc: ManifestPreviewServiceInput,
): BuildManifestOptions {
  return {
    image: svc.image,
    ports: svc.ports ?? {},
    env: svc.env,
    command: svc.command ? [...svc.command] : undefined,
    args: svc.args ? [...svc.args] : undefined,
    user: svc.user,
    tmpfs: svc.tmpfs ? [...svc.tmpfs] : undefined,
    health_check: svc.health_check,
    stop_grace_period: svc.stop_grace_period,
    depends_on: svc.depends_on,
    expose: svc.expose ? [...svc.expose] : undefined,
    labels: svc.labels,
  };
}

/**
 * Builds and validates a deployment manifest without touching the chain or
 * any provider. Use this before `deploy_app` to confirm the manifest is
 * accepted by the documented Fred rules and to compute the SHA-256
 * `meta_hash` that will be recorded on-chain.
 *
 * Two input modes:
 *   - Raw JSON: pass `manifest` (a JSON string).
 *   - Structured: pass `image`+`port` (single-service) or `services` (stack),
 *     mirroring `deploy_app`'s shape.
 *
 * The returned `manifest_json` is the exact byte sequence that would be
 * uploaded; `meta_hash_hex` is its SHA-256. Validation errors are returned
 * inside the result rather than thrown — the caller decides what to do.
 *
 * Hard structural failures (mutual-exclusion violations, invalid JSON in
 * `manifest`, missing required fields) DO throw, since there is no
 * meaningful preview to return.
 */
export async function buildManifestPreview(
  input: BuildManifestPreviewInput,
): Promise<BuildManifestPreviewResult> {
  let manifestObj: Record<string, unknown>;

  if (input.manifest !== undefined) {
    if (hasAnyStructuredField(input)) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'manifest is mutually exclusive with structured fields (image/port/services/...)',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.manifest);
    } catch (err) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'manifest must be a JSON object',
      );
    }
    manifestObj = parsed as Record<string, unknown>;
  } else if (input.services !== undefined) {
    if (input.image !== undefined || input.port !== undefined) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'services is mutually exclusive with image/port',
      );
    }
    const services: Record<string, BuildManifestOptions> = {};
    for (const [name, svc] of Object.entries(input.services)) {
      services[name] = toBuildOptions(svc);
    }
    manifestObj = buildStackManifest({ services }) as Record<string, unknown>;
  } else if (input.image !== undefined) {
    if (input.port === undefined) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'port is required when using image',
      );
    }
    manifestObj = buildManifest({
      image: input.image,
      ports: { [`${input.port}/tcp`]: {} },
      env: input.env,
      command: input.command ? [...input.command] : undefined,
      args: input.args ? [...input.args] : undefined,
      user: input.user,
      tmpfs: input.tmpfs ? [...input.tmpfs] : undefined,
      health_check: input.health_check,
      stop_grace_period: input.stop_grace_period,
      init: input.init,
      expose: input.expose ? [...input.expose] : undefined,
      labels: input.labels,
      depends_on: input.depends_on,
    });
  } else {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'one of manifest, services, or image is required',
    );
  }

  const manifestJson = JSON.stringify(manifestObj);
  const hash = await metaHashHex(manifestJson);
  const validation = validateManifest(manifestObj);

  // Format is derived from the parsed manifest. validateManifest returns null
  // only when the value isn't even a JSON object, which we've already
  // rejected above. Fall back to single for type narrowing.
  const format: ManifestFormat = isStackManifest(manifestObj)
    ? 'stack'
    : 'single';

  return {
    manifest_json: manifestJson,
    manifest: manifestObj,
    format,
    meta_hash_hex: hash,
    validation: {
      valid: validation.valid,
      errors: validation.errors,
    },
  };
}
