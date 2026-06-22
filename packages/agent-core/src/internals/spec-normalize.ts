import type { AppDeploySpec, ServiceConfig, SpecSummary } from '../types.js';

/**
 * Spec normalization + summarization helpers. Exports `isStack`,
 * `firstImage`, `normalizeServices`, `summarizeSpec`, and `validateSpec`
 * (the latter surfaces pre-broadcast shape violations).
 *
 * The single canonical spec type (`AppDeploySpec`, ENG-310) covers two
 * shapes, discriminated by the presence of `services`:
 *   - **stack** — `{ services: { <name>: ServiceConfig }, customDomain?, serviceName?, size, ... }`
 *   - **single-service** — `{ image, port?, env?, customDomain?, size, ... }`
 *
 * `normalizeServices` collapses the two shapes into a single iterable form
 * so callers (Plan summary, manifest builder, etc.) walk one structure
 * regardless of which form the user passed.
 *
 * Validation: `validateSpec` stays a `void` `TypeError`-thrower on shape
 * violations. The high-level `deployApp` entry wrappers
 * (`deploy-app.ts`) map that `TypeError` to
 * `ManifestMCPError(INVALID_CONFIG)` at the public-API boundary, so this
 * helper does not depend on core's error type directly.
 */

/**
 * True when `spec` uses the services-map (stack) shape. Discriminates on
 * the canonical `services` key being present and defined (ENG-310). The
 * non-null-object / non-array guard is retained as defense-in-depth so an
 * `unknown`-cast caller smuggling `services: null` / `[]` / `'str'` is NOT
 * mistaken for a stack (which would crash `Object.entries` downstream).
 */
export function isStackSpec(
  spec: unknown,
): spec is AppDeploySpec & { services: Record<string, ServiceConfig> } {
  if (spec === null || spec === undefined || typeof spec !== 'object')
    return false;
  const record = spec as { services?: unknown };
  if (!('services' in record) || record.services === undefined) return false;
  const services = record.services;
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
export function firstImage(spec: unknown): string | null {
  if (spec === null || spec === undefined || typeof spec !== 'object')
    return null;
  const single = spec as Partial<AppDeploySpec>;
  if (typeof single.image === 'string' && single.image.length > 0) {
    return single.image;
  }
  if (isStackSpec(spec)) {
    for (const svc of Object.values(spec.services)) {
      if (svc !== null && typeof svc === 'object') {
        const image = (svc as Partial<ServiceConfig>).image;
        if (typeof image === 'string' && image.length > 0) return image;
      }
    }
  }
  return null;
}

/**
 * Walk a spec as `[{name, raw}]` where:
 *   - `name === null` for legacy single-service (only one entry, raw is the spec itself).
 *   - `name === <key>` for each services-map entry; `raw` is the per-service ServiceConfig.
 *
 * Stable iteration order matches `Object.entries` (insertion order in v8/modern engines).
 */
export interface NormalizedService {
  /** `null` for legacy single-service; the services-map key for stack leases. */
  name: string | null;
  /** The per-service object exactly as the spec stores it. No field projection. */
  raw: ServiceConfig | AppDeploySpec;
}

export function normalizeServices(spec: unknown): NormalizedService[] {
  if (isStackSpec(spec)) {
    return Object.entries(spec.services).map(([name, raw]) => ({
      name,
      raw: (raw ?? {}) as ServiceConfig,
    }));
  }
  return [
    {
      name: null,
      raw: (spec ?? {}) as AppDeploySpec,
    },
  ];
}

/**
 * Produce the frozen `SpecSummary` shape for inclusion in the `Plan`
 * (camelCase fields: `serviceCount`, etc.).
 *
 * Port count rules:
 *   - single-service `port: number` → +1 port.
 *   - `ServiceConfig.ports` map (canonical `{ '<port>/<proto>': {} }`) →
 *     +key count.
 *   - A bare `port`/`ports` array smuggled in by an `unknown`-cast caller
 *     is still counted defensively (+1 / +length) below.
 *
 * Env key uniqueness is computed across services (one `env_keys` set
 * spans the whole spec); `envCount` is the size of that set; `envKeys`
 * is sorted ascending.
 */
export function summarizeSpec(spec: unknown): SpecSummary {
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
 * Validate an `AppDeploySpec` shape pre-broadcast. Throws `TypeError` on
 * the first violation. The canonical type already enforces most
 * structural rules at compile time; this runtime check defends against
 * `unknown`-cast callers and `JSON.parse`-decoded inputs (and the
 * image-XOR-services invariant the type cannot express).
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
export function validateSpec(spec: unknown): void {
  if (spec === null || spec === undefined || typeof spec !== 'object') {
    throw new TypeError('validateSpec: spec must be a non-null object');
  }
  const record = spec as unknown as Record<string, unknown>;

  // Mutual-exclusion gate uses KEY presence (not value validity). This
  // closes the bypass where a caller supplies a malformed `image` value
  // (empty string, number, null) alongside a valid `services` map: the
  // value-based check would silently treat `image` as "absent" and accept
  // the spec, but the caller's intent was ambiguous (which shape did they
  // mean?). Rejecting on key-presence forces the caller to delete one key
  // before submission and removes the ambiguity.
  const hasImageKey = 'image' in record;
  const hasServicesKey = 'services' in record;
  if (hasImageKey && hasServicesKey) {
    throw new TypeError(
      'validateSpec: spec has both `image` and `services` keys; these are mutually exclusive (regardless of value validity)',
    );
  }

  // Downstream value-validity check (after the mutual-exclusion gate has
  // ruled out the ambiguous case). An `image` key with a non-string or
  // empty-string value still fails here when `services` is absent.
  const hasImage = typeof record.image === 'string' && record.image.length > 0;
  const hasServices = isStackSpec(spec);
  if (!hasImage && !hasServices) {
    throw new TypeError(
      'validateSpec: spec must declare either `image` (single-service) or `services` (stack)',
    );
  }

  // Copilot review fix (PR #58 r3266786899): `customDomain` shape at
  // the boundary. Historically the orchestrator's `buildFredDeployInput`
  // mapper used an `if (customDomain)` truthiness check that silently
  // dropped `''`, `null`, `false`, `0`, `NaN` from the emitted
  // `fredInput`, so a spec like `{ ..., customDomain: '' }` deployed with
  // the domain silently not claimed. ENG-310 deleted that mapper: the
  // loss-free broadcast spread now forwards `customDomain` to fred
  // verbatim, so an empty/whitespace value would instead reach fred as a
  // claim for an invalid domain. Either way the fix is the same — reject
  // a malformed `customDomain` here, at the boundary, before it can do harm.
  //
  // Boundary check: when `customDomain` is present, it must be a
  // non-empty string. `undefined` (key absent) is fine; that's the
  // "no domain requested" case. Fires before the stack-customDomain
  // serviceName check (r3249684707) so the user gets a clear
  // customDomain-shape error rather than a misleading
  // requires-serviceName one.
  // Copilot review fix (PR #58 r3267373001): reject whitespace-only
  // strings AND strings with surrounding whitespace (option (i) from
  // the team-lead's brief — strict; let the caller send a clean,
  // already-trimmed value rather than silently trim for them). The
  // prior `cd.length === 0` predicate accepted `'   '`, `'\t\n'`,
  // and `' app.example.com '`; fred would either accept the
  // surrounding whitespace as part of the domain (correctness bug)
  // or trim-and-reject (worse UX than agent-core's clear error).
  if ('customDomain' in record) {
    const cd = record.customDomain;
    if (cd !== undefined) {
      const isCleanNonEmptyString =
        typeof cd === 'string' && cd.length > 0 && cd.trim() === cd;
      if (!isCleanNonEmptyString) {
        const got =
          typeof cd === 'string'
            ? cd.trim().length === 0
              ? `"${cd}"`
              : `"${cd}" (has surrounding whitespace)`
            : cd === null
              ? 'null'
              : typeof cd;
        throw new TypeError(
          `validateSpec: \`customDomain\` must be a non-empty trimmed string or absent (got ${got}).`,
        );
      }
    }
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
      const image = (svc as Partial<ServiceConfig>).image;
      if (typeof image !== 'string' || image.length === 0) {
        throw new TypeError(
          `validateSpec: stack service "${name}" must declare a non-empty \`image\` string`,
        );
      }
    }

    // Copilot review fix (PR #58 r3249684707): a stack spec with a
    // `customDomain` MUST declare which service receives the domain
    // via `serviceName`, and that value must be a key in `services`.
    // Without this guard, `customDomainServiceOf` in `deploy-app.ts`
    // returns `undefined`, planning proceeds with no target, renderers
    // misrepresent the claim, and fred rejects the set-domain tx
    // ONLY after `create-lease` commits — leaving the user with an
    // orphan lease + a failed domain claim. Catching this at
    // validate-time is fail-fast at the boundary.
    //
    // Single-service specs are unaffected: their `customDomain` is
    // claimed against the implicit single lease item — no
    // serviceName disambiguation needed.
    const stackDomain = (spec as Partial<AppDeploySpec>).customDomain;
    if (typeof stackDomain === 'string' && stackDomain.length > 0) {
      const stackServiceName = (spec as Partial<AppDeploySpec>).serviceName;
      if (
        typeof stackServiceName !== 'string' ||
        stackServiceName.length === 0
      ) {
        throw new TypeError(
          'validateSpec: stack spec with `customDomain` requires `serviceName` identifying which service receives the domain.',
        );
      }
      // Copilot review fix (PR #58 r3250331968): use an own-key check.
      // The `in` operator walks the prototype chain, so `serviceName:
      // 'constructor'` (or `'toString'`, `'hasOwnProperty'`, etc.)
      // would falsely pass against a `services` map that doesn't
      // declare those names. Mirrors fred's own choice at
      // `packages/fred/src/tools/deployApp.ts:254` for cross-package
      // symmetry. `Object.keys().includes()` (not `Object.hasOwn`,
      // which is ES2022 and our `tsdown.config.ts` targets ES2020).
      if (!Object.keys(spec.services).includes(stackServiceName)) {
        throw new TypeError(
          `validateSpec: stack spec \`serviceName\` "${stackServiceName}" must be a key in \`services\` (got services: [${Object.keys(spec.services).join(', ')}]).`,
        );
      }
    }
  } else {
    // Single-service spec port requirement.
    //
    // Copilot review fix (PR #58 r3249097051): fred's image-mode rejects
    // portless inputs with `port is required when using image`
    // (`packages/fred/src/tools/deployApp.ts:202` +
    // `packages/fred/src/tools/buildManifestPreview.ts:181`). Without
    // an agent-core boundary check the orchestrator would pass
    // `port: undefined` straight through the loss-free broadcast spread
    // to fred, surfacing fred's error mid-orchestration (after readiness
    // check + plan render). Failing fast at validate time produces a
    // clearer message and avoids partial work.
    //
    // The escape hatch for genuinely internal-only services is the
    // stack spec — service-level `ports` is optional, so a stack with
    // `{ services: { mysvc: { image, env } } }` deploys without ports.
    //
    // Copilot review fix (PR #58 r3249294877): tighten the predicate to
    // a finite positive integer in the TCP port range. The prior
    // `typeof p === 'number'` check accepted `0`, `NaN`, `Infinity`,
    // negative numbers, non-integers, and out-of-range ports —
    // partially defeating the fail-fast intent. Fred catches `port: 0`
    // via `!input.port`, but the other shapes either flow through to a
    // less helpful error or get coerced silently. The shared predicate
    // `isValidPortNumber` (below) is the single source of truth.
    // Read as `unknown`: the canonical AppDeploySpec.port is `number`, but
    // this runtime guard also accepts a legacy `number[]` smuggled in by an
    // `unknown`-cast / JSON.parse caller (the array branch below) — typing it
    // `unknown` keeps `Array.isArray` from narrowing to `never` (ENG-310).
    const port: unknown = (spec as { port?: unknown }).port;
    const hasValidPort =
      isValidPortNumber(port) ||
      (Array.isArray(port) && port.length > 0 && port.every(isValidPortNumber));
    if (!hasValidPort) {
      throw new TypeError(
        'validateSpec: single-service specs require at least one port (port must be a finite positive integer in the TCP range (1-65535), or a non-empty array of such); got ' +
          `port=${JSON.stringify(port)}. For internal-only services, use a stack spec instead.`,
      );
    }
  }
}

/**
 * Predicate: `p` is a finite positive integer in the TCP port range
 * (1-65535). Used by `validateSpec` to gate single-service `port`
 * shapes against the broad `typeof === 'number'` bypass.
 *
 * Co-located in this module because it's exclusive to the port-
 * validation boundary; if a future caller needs the same check,
 * promote it to a shared utility then.
 */
function isValidPortNumber(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535;
}
