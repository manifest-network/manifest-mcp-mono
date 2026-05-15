/**
 * Helpers for walking the provider's `connection` payload returned by
 * `mcp__manifest-fred__deploy_app` / `app_status` / `wait_for_app_ready`.
 * 1:1 port of `manifest-agent-plugin/scripts/_connection.cjs`.
 *
 * The provider emits instance lists in one or both of:
 *   - top-level `connection.instances[]` (single-service / non-services-map shape)
 *   - per-service `connection.services.<name>.instances[]` (stack /
 *     services-map shape — emitted whenever the spec uses services-map form,
 *     which `build_manifest_preview` does even for single-service deploys to
 *     enable per-port `ingress: bool`)
 *
 * Subdomain-based routing on the provider: port is NOT part of the URL.
 * One user-facing URL per FQDN regardless of container port count.
 *
 * Unrecognized payload shape: returns `[]` and invokes the logger
 * (defaults to `console.warn`; override via `opts.logger`) so a future
 * provider-shape divergence is loud rather than silent. The CJS uses
 * `process.stderr.write`; the TS port surfaces via an injectable logger
 * to keep agent-core platform-neutral while preserving the always-loud
 * CJS posture by default.
 */

export interface RunningEndpoint {
  readonly fqdn: string;
}

export interface ConnectionWalkOptions {
  /**
   * Sink for warnings about unrecognized connection shapes. Defaults to
   * `console.warn` (Web Standard; platform-neutral across Node, browsers,
   * Deno, Bun). Mirrors the CJS's unconditional-stderr posture so a future
   * provider-shape divergence is loud rather than silent. Surfaces that
   * want to route elsewhere (plugin → structured stderr, Barney → UI
   * toast, daemon → log file) can override; surfaces that want to
   * suppress entirely can pass `() => {}` explicitly — silence becomes a
   * consumer-controlled opt-out instead of the easy-to-forget default.
   */
  logger?: (reason: string) => void;
}

/**
 * Returns a deduped list of running instances (status === 'running' AND
 * `fqdn` populated) found anywhere under `connection.instances` or
 * `connection.services.<name>.instances`.
 */
export function extractRunningEndpoints(
  connection: unknown,
  opts: ConnectionWalkOptions = {},
): RunningEndpoint[] {
  if (!isPlainObject(connection)) return [];
  const seen = new Set<string>();
  const endpoints: RunningEndpoint[] = [];

  const pushFromInstances = (instances: unknown): void => {
    if (!Array.isArray(instances)) return;
    for (const inst of instances) {
      if (!isPlainObject(inst)) continue;
      if (inst.status !== 'running') continue;
      if (typeof inst.fqdn !== 'string' || inst.fqdn.length === 0) continue;
      if (seen.has(inst.fqdn)) continue;
      seen.add(inst.fqdn);
      endpoints.push({ fqdn: inst.fqdn });
    }
  };

  pushFromInstances(connection.instances);

  const services = connection.services;
  if (isPlainObject(services)) {
    for (const svc of Object.values(services)) {
      if (isPlainObject(svc)) pushFromInstances(svc.instances);
    }
  }

  // Only warn when neither `instances` nor `services` is present at all.
  // The empty-but-present case (no instance has status 'running') is a
  // legitimate "lease pending, wait_for_app_ready hasn't returned yet" state
  // — returning [] there is the correct, non-warning behavior.
  // Object.keys + includes avoids both ES2022's `Object.hasOwn` (base
  // tsconfig targets ES2020) and biome's `noPrototypeBuiltins` rule on
  // `Object.prototype.hasOwnProperty.call`.
  const ownKeys = Object.keys(connection);
  const hasModernShape =
    ownKeys.includes('instances') || ownKeys.includes('services');
  if (!hasModernShape) {
    const keys = Object.keys(connection).slice(0, 8).join(', ') || '(empty)';
    const logger = opts.logger ?? defaultLogger;
    logger(
      `connection: unrecognized shape (no 'instances' or 'services' key found; keys present: ${keys}). ` +
        'Returning empty endpoints — the orchestrator will report no ingresses for this lease. ' +
        'Provider may have shipped a new shape; check manifest-mcp-fred ConnectionDetails.',
    );
  }

  return endpoints;
}

/** Render an endpoint as a bare FQDN string (for ingress lists). */
export function formatEndpointAsIngress(ep: RunningEndpoint): string {
  return ep.fqdn;
}

/** Render an endpoint as a full `https://<fqdn>/` URL. */
export function formatEndpointAsUrl(ep: RunningEndpoint): string {
  return `https://${ep.fqdn}/`;
}

/**
 * Normalize fred's top-level `url` field to a full `http(s)://...`
 * string. Defensive fallback for the legacy `connection.host` / `ports`
 * shape: fred surfaces a top-level `url` when no `connection.instances`
 * FQDN is available, and the value may or may not carry a scheme.
 *
 * Mirrors the inline logic that lived in three call sites
 * (`classify-deploy-response.ts:76-80`, `format-success.ts` ingress
 * fallback, `deploy-app.ts` `DeployResult.urls` fallback) — factored
 * here so all three share one source of truth.
 *
 * - Returns `''` for empty input (caller branches into a different
 *   render path if needed).
 * - Passes through unchanged if already prefixed `http://` or
 *   `https://` (case-insensitive).
 * - Otherwise wraps as `https://${raw}/`.
 */
export function normalizeFredUrl(raw: string): string {
  if (raw.length === 0) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}/`;
}

/**
 * True iff any instance anywhere in the connection payload has
 * `status === 'running'`, regardless of `fqdn`. Used by
 * `classify-deploy-response.ts` to recognize internal-only deploys
 * (every port `ingress: false`) as `active` rather than misclassifying
 * them as `needs_wait` because they have no public URLs to surface.
 */
export function hasRunningInstances(connection: unknown): boolean {
  if (!isPlainObject(connection)) return false;
  const runs = (instances: unknown): boolean =>
    Array.isArray(instances) &&
    instances.some((i) => isPlainObject(i) && i.status === 'running');
  if (runs(connection.instances)) return true;
  const services = connection.services;
  if (isPlainObject(services)) {
    for (const svc of Object.values(services)) {
      if (isPlainObject(svc) && runs(svc.instances)) return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Default logger — `console.warn`. Defined as a module-level constant so
 * test code can spy on it (`vi.spyOn(console, 'warn')`) without races
 * around the import order of the binding.
 */
const defaultLogger: (reason: string) => void = (reason) => {
  console.warn(reason);
};
