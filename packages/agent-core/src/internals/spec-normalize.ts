import type {
  DeploySpec,
  ServiceDef,
  SingleServiceSpec,
  SpecSummary,
  StackSpec,
} from '../types.js';

/**
 * Spec normalization + summarization helpers. Ports
 * `manifest-agent-plugin/scripts/_spec.cjs` (the three sibling helpers
 * `isStack`, `firstImage`, `normalizeServices`) and the
 * `summarizeSpec()` body from `_journal.cjs` (which mirrors the plugin's
 * `summarize-spec.cjs` in-process). Adds `validateSpec()` to surface
 * pre-broadcast shape violations.
 *
 * Two spec shapes are supported (frozen in ENG-128's `types.ts`):
 *   - **services-map (StackSpec)** — `{ services: { <name>: ServiceDef }, customDomain?, serviceName? }`
 *   - **legacy single-service (SingleServiceSpec)** — `{ image, port?, env?, customDomain? }`
 *
 * `normalizeServices` collapses the two shapes into a single iterable form
 * so callers (Plan summary, manifest builder, etc.) walk one structure
 * regardless of which form the user passed.
 *
 * Validation: `validateSpec` throws a plain `TypeError` on shape violations
 * — agent-core has no workspace dep on `@manifest-network/manifest-mcp-core`
 * in PR 1/2 (per parent's REV 1), so `ManifestMCPError` isn't available
 * here. PR 3's high-level `deployApp` re-wraps `TypeError` into
 * `ManifestMCPError(INVALID_INPUT)` at the public-API boundary.
 */

/**
 * True when `spec` uses the services-map shape (StackSpec). Mirrors
 * `_spec.cjs#isStack`: `services` is a non-null, non-array object.
 */
export function isStackSpec(
  spec: DeploySpec | null | undefined,
): spec is StackSpec {
  if (spec === null || spec === undefined || typeof spec !== 'object')
    return false;
  const services = (spec as { services?: unknown }).services;
  return (
    services !== null &&
    typeof services === 'object' &&
    !Array.isArray(services)
  );
}

/**
 * Return the canonical first image string for a spec. For legacy single-
 * service: `spec.image`. For stack: the first non-empty `image` in
 * `Object.values(spec.services)`. Returns `null` when neither shape
 * carries an image (or `spec` is malformed).
 */
export function firstImage(spec: DeploySpec | null | undefined): string | null {
  if (spec === null || spec === undefined || typeof spec !== 'object')
    return null;
  const single = spec as Partial<SingleServiceSpec>;
  if (typeof single.image === 'string' && single.image.length > 0) {
    return single.image;
  }
  if (isStackSpec(spec)) {
    for (const svc of Object.values(spec.services)) {
      if (svc !== null && typeof svc === 'object') {
        const image = (svc as Partial<ServiceDef>).image;
        if (typeof image === 'string' && image.length > 0) return image;
      }
    }
  }
  return null;
}

/**
 * Walk a spec as `[{name, raw}]` where:
 *   - `name === null` for legacy single-service (only one entry, raw is the spec itself).
 *   - `name === <key>` for each services-map entry; `raw` is the per-service ServiceDef.
 *
 * Stable iteration order matches `Object.entries` (insertion order in v8/modern engines).
 */
export interface NormalizedService {
  /** `null` for legacy single-service; the services-map key for stack leases. */
  name: string | null;
  /** The per-service object exactly as the spec stores it. No field projection. */
  raw: ServiceDef | SingleServiceSpec;
}

export function normalizeServices(
  spec: DeploySpec | null | undefined,
): NormalizedService[] {
  if (isStackSpec(spec)) {
    return Object.entries(spec.services).map(([name, raw]) => ({
      name,
      raw: (raw ?? {}) as ServiceDef,
    }));
  }
  return [
    {
      name: null,
      raw: (spec ?? {}) as SingleServiceSpec,
    },
  ];
}

/**
 * Produce the frozen `SpecSummary` shape for inclusion in the `Plan`.
 * Mirrors `_journal.cjs#summarizeSpec` (which itself mirrors plugin's
 * `summarize-spec.cjs`) with the wire-name snake_case fields renamed to
 * the frozen camelCase form (`service_count` → `serviceCount`, etc.).
 *
 * Port count rules (from CJS):
 *   - SingleServiceSpec `port: number` → +1 port.
 *   - SingleServiceSpec `port: number[]` → +length ports.
 *   - ServiceDef `ports: number[]` (per type) → +length ports.
 *   - ServiceDef `ports` shaped as a Record (older codepath) → +key count.
 *
 * Env key uniqueness is computed across services (one `env_keys` set
 * spans the whole spec); `envCount` is the size of that set; `envKeys`
 * is sorted ascending.
 */
export function summarizeSpec(spec: DeploySpec): SpecSummary {
  const format: 'single' | 'stack' = isStackSpec(spec) ? 'stack' : 'single';
  const services = normalizeServices(spec);

  let portCount = 0;
  const envKeys = new Set<string>();
  const images: string[] = [];

  for (const { raw: svc } of services) {
    if (svc !== null && typeof svc === 'object') {
      const svcRecord = svc as unknown as Record<string, unknown>;
      const image = svcRecord.image;
      if (typeof image === 'string' && image.length > 0) images.push(image);

      const port = svcRecord.port;
      if (typeof port === 'number') portCount += 1;
      else if (Array.isArray(port)) portCount += port.length;

      const ports = svcRecord.ports;
      if (Array.isArray(ports)) {
        portCount += ports.length;
      } else if (ports !== null && typeof ports === 'object') {
        portCount += Object.keys(ports).length;
      }

      const env = svcRecord.env;
      if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
        for (const k of Object.keys(env)) envKeys.add(k);
      }
    }
  }

  return {
    format,
    serviceCount: services.length,
    portCount,
    envCount: envKeys.size,
    envKeys: Array.from(envKeys).sort(),
    images,
  };
}

/**
 * Validate a `DeploySpec` shape pre-broadcast. Throws `TypeError` on the
 * first violation. The frozen type union (`SingleServiceSpec | StackSpec`)
 * already enforces most structural rules at compile time; this runtime
 * check defends against `unknown`-cast callers and `JSON.parse`-decoded
 * inputs.
 *
 * Rules (mirror fred's `deployApp.ts` input validation):
 *   - `spec` must be a non-null object.
 *   - Stack: `services` must have ≥1 entry; each entry's `image` must be a
 *     non-empty string.
 *   - Single: `image` must be a non-empty string.
 *   - Mutually exclusive `image` AND `services` not allowed.
 *
 * The high-level `deployApp` in PR 3 layers domain checks on top
 * (`customDomain` shape, `serviceName` membership, etc.).
 */
export function validateSpec(spec: DeploySpec | null | undefined): void {
  if (spec === null || spec === undefined || typeof spec !== 'object') {
    throw new TypeError('validateSpec: spec must be a non-null object');
  }
  const record = spec as unknown as Record<string, unknown>;
  const hasImage = typeof record.image === 'string' && record.image.length > 0;
  const hasServices = isStackSpec(spec);

  if (hasImage && hasServices) {
    throw new TypeError(
      'validateSpec: spec uses both `image` and `services`; these are mutually exclusive',
    );
  }
  if (!hasImage && !hasServices) {
    throw new TypeError(
      'validateSpec: spec must declare either `image` (SingleServiceSpec) or `services` (StackSpec)',
    );
  }

  if (hasServices) {
    const entries = Object.entries(spec.services);
    if (entries.length === 0) {
      throw new TypeError(
        'validateSpec: stack spec `services` must have at least one entry',
      );
    }
    for (const [name, svc] of entries) {
      if (svc === null || typeof svc !== 'object') {
        throw new TypeError(
          `validateSpec: stack service "${name}" must be a non-null object`,
        );
      }
      const image = (svc as Partial<ServiceDef>).image;
      if (typeof image !== 'string' || image.length === 0) {
        throw new TypeError(
          `validateSpec: stack service "${name}" must declare a non-empty \`image\` string`,
        );
      }
    }
  }
}
