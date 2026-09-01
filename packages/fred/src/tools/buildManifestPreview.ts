import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import {
  type BuildManifestOptions,
  buildManifest,
  buildStackManifest,
  type ManifestFormat,
  metaHashHex,
  validateManifest,
} from '../manifest.js';
import {
  duplicateJsonObjectKeyErrorMessage,
  findDuplicateJsonObjectKey,
  findInvalidJsonNumberLiteral,
  jsonNumberLiteralErrorMessage,
  MAX_MANIFEST_BYTES,
} from './validateManifestPayload.js';

export interface ManifestPreviewServiceInput {
  readonly image: string;
  readonly ports?: BuildManifestOptions['ports'];
  readonly env?: Record<string, string>;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly user?: string;
  readonly tmpfs?: readonly string[];
  readonly health_check?: BuildManifestOptions['health_check'];
  readonly stop_grace_period?: string | number;
  readonly init?: boolean;
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
  readonly stop_grace_period?: string | number;
  readonly init?: boolean;
  readonly expose?: readonly string[];
  readonly labels?: Record<string, string>;
  readonly depends_on?: Record<string, { condition: string }>;
  /** Stack manifest. Mutually exclusive with every top-level single-service field and `manifest`. */
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

const SINGLE_SERVICE_STRUCTURED_FIELDS = STRUCTURED_FIELDS.filter(
  (field) => field !== 'services',
);

function hasAnyStructuredField(input: BuildManifestPreviewInput): boolean {
  return STRUCTURED_FIELDS.some((k) => input[k] !== undefined);
}

function toBuildOptions(
  service: ManifestPreviewServiceInput,
): BuildManifestOptions {
  return {
    image: service.image,
    ports: service.ports ?? {},
    env: service.env,
    command: service.command ? [...service.command] : undefined,
    args: service.args ? [...service.args] : undefined,
    user: service.user,
    tmpfs: service.tmpfs ? [...service.tmpfs] : undefined,
    health_check: service.health_check,
    stop_grace_period: service.stop_grace_period,
    init: service.init,
    depends_on: service.depends_on,
    expose: service.expose ? [...service.expose] : undefined,
    labels: service.labels,
  };
}

/**
 * Builds and validates a deployment manifest without touching the chain or
 * any provider. Use this before `deploy_app` to confirm the manifest is
 * accepted by the documented Fred rules and, for a valid candidate, to
 * compute the SHA-256 `meta_hash` the corresponding deploy will record.
 *
 * Two input modes:
 *   - Raw JSON: pass `manifest` (a JSON string).
 *   - Structured: pass `image`+`port` (single-service) or `services` (stack),
 *     mirroring `deploy_app`'s shape.
 *
 * For raw JSON and valid structured input, the returned `manifest_json` is the
 * exact byte sequence the corresponding deploy path uploads and
 * `meta_hash_hex` is its SHA-256. Invalid structured input is preserved for an
 * actionable preview; its hash identifies that rejected candidate and cannot
 * be recorded on-chain. Validation errors are returned inside the result
 * rather than thrown — the caller decides what to do.
 *
 * Hard structural failures (mutual-exclusion violations, invalid JSON in
 * `manifest`, missing required fields) DO throw, since there is no
 * meaningful preview to return.
 */
export async function buildManifestPreview(
  input: BuildManifestPreviewInput,
): Promise<BuildManifestPreviewResult> {
  let manifestObj: Record<string, unknown>;
  let exactManifestJson: string | undefined;
  let duplicateKey: string | undefined;

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
    exactManifestJson = input.manifest;
    duplicateKey = findDuplicateJsonObjectKey(input.manifest);
  } else if (input.services !== undefined) {
    const mixedFields = SINGLE_SERVICE_STRUCTURED_FIELDS.filter(
      (field) => input[field] !== undefined,
    );
    if (mixedFields.length > 0) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        `services is mutually exclusive with single-service fields: ${mixedFields.join(', ')}`,
      );
    }
    if (Object.keys(input.services).length === 0) {
      // services={} is a hard structural failure: caller signalled stack
      // intent but defined zero services. Without this guard, the empty
      // map cannot produce a useful deploy preview. Per the docstring, hard
      // structural failures throw.
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_CONFIG,
        'services is empty; provide at least one service or use image/port for a single-service manifest',
      );
    }
    // Preserve the structured object exactly. Preview is deliberately more
    // permissive than deploy parsing so unsupported Compose fields and fixed
    // host ports can be returned as actionable validation errors instead of
    // being stripped or rejected as protocol-level -32602 errors.
    manifestObj = {
      services: Object.fromEntries(
        Object.entries(input.services).map(([name, service]) => [
          name,
          { ...service },
        ]),
      ),
    };
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

  const semanticValidation = validateManifest(manifestObj);
  const validationErrors = [...semanticValidation.errors];

  // A valid structured stack follows the exact same canonical builder as
  // deployApp (including default empty `ports` objects). Invalid candidates
  // stay untouched so unsupported keys remain visible in the preview.
  if (input.services !== undefined && semanticValidation.valid) {
    manifestObj = buildStackManifest({
      services: Object.fromEntries(
        Object.entries(input.services).map(([name, service]) => [
          name,
          toBuildOptions(service),
        ]),
      ),
    });
  }

  const manifestJson = exactManifestJson ?? JSON.stringify(manifestObj);
  const invalidNumber = findInvalidJsonNumberLiteral(manifestJson);
  if (invalidNumber !== undefined) {
    validationErrors.push(
      jsonNumberLiteralErrorMessage(invalidNumber, 'manifest:'),
    );
  }
  if (duplicateKey !== undefined) {
    validationErrors.push(
      duplicateJsonObjectKeyErrorMessage(duplicateKey, 'manifest:'),
    );
  }
  const manifestBytes = new TextEncoder().encode(manifestJson).length;
  if (manifestBytes > MAX_MANIFEST_BYTES) {
    validationErrors.push(
      `manifest: is ${manifestBytes} bytes; the maximum is ${MAX_MANIFEST_BYTES}`,
    );
  }
  const hash = await metaHashHex(manifestJson);

  // validateManifest returns null only when the value is not a JSON object,
  // which was rejected above. Keep the fallback solely for type narrowing.
  const format: ManifestFormat = semanticValidation.format ?? 'single';

  return {
    manifest_json: manifestJson,
    manifest: manifestObj,
    format,
    meta_hash_hex: hash,
    validation: {
      valid:
        semanticValidation.valid &&
        invalidNumber === undefined &&
        duplicateKey === undefined &&
        manifestBytes <= MAX_MANIFEST_BYTES,
      errors: validationErrors,
    },
  };
}
