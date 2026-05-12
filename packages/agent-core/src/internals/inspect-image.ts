import { createGuardedFetch } from './guarded-fetch.js';

/**
 * Inspect a public container image via the OCI Distribution API. Returns
 * the manifest digest, exposed ports, image defaults (env / cmd /
 * entrypoint / user / workingDir), healthcheck, labels, volumes, and a
 * heuristic `suggestedTmpfs` list for known-good Fred image families.
 *
 * 1:1 port of `manifest-agent-plugin/scripts/inspect-image.cjs`. The CJS
 * shells the request chain through `_https-json.cjs`'s `https.request` +
 * `RequestFilteringHttpsAgent` (a Node-only SSRF-blocking agent). The TS
 * port replaces that with `opts.fetch`, defaulting to `createGuardedFetch()`
 * (DIY undici Dispatcher + RFC-cited block ranges + IPv4-mapped IPv6
 * normalization — see `guarded-fetch.ts` for the design).
 *
 * **Fail-soft contract preserved from CJS:** returns `null` (the TS
 * analog of the CJS's stdout `{}`) on every non-fatal failure mode:
 *   - 401 / 403 (private registry / auth required)
 *   - 429 (Docker Hub rate-limit)
 *   - OCI grammar violation in the `imageRef`
 *   - Manifest body exceeding the 10 MiB cap
 *   - Request timeout (10s)
 *   - Unparseable manifest / blob JSON
 *   - SSRF block (default fetch refuses RFC 1918 / loopback / etc.)
 * Callers treat `null` as "no info, ask the user" verbatim from the CJS.
 * Diagnostics flow through `opts.logger` instead of stderr.
 *
 * ## Security — SSRF (production callers MUST read)
 *
 * `imageRef` is user-controlled (it comes from `DeploySpec.image`).
 * Without an SSRF guard, an image ref like `169.254.169.254:80/foo:bar`
 * (cloud-metadata) or `127.0.0.1:6379/foo:bar` (local Redis) would
 * cause this function to probe internal services on the host. The CJS
 * blocks this via its SSRF-aware HTTPS agent; the TS port delegates to
 * the caller's `opts.fetch`, defaulting to `createGuardedFetch()` which
 * blocks at connect time.
 *
 * Opt-out-of-safety semantics (parent's PR-2 directive): the default
 * `opts.fetch = createGuardedFetch()` is safe by construction. Callers
 * pass their own `opts.fetch` ONLY for tests (canned responses) or
 * unusual production cases (e.g. a trusted private registry on an RFC
 * 1918 IP, after explicit allow-listing). See `createGuardedFetch`'s
 * JSDoc for the production-guard contract.
 */

const ACCEPT_MANIFEST = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

// OCI Distribution Spec v1.1 grammar for URL-interpolated fields. Validate
// BEFORE the URL is constructed; the `imageRef` flag is user-controlled,
// so a malformed input like `foo/bar:..%2F..%2Fconfig` must be rejected
// here rather than forwarded to the registry.
const OCI_NAME_COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
const OCI_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;

// Body-size cap (10 MiB). Real-world configs are <100 KB; even JVM-rich
// images rarely exceed a few MB. Anything over 10 MiB indicates a hostile
// or buggy registry; abort rather than risk OOM.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// Request timeout — 10s. Tighter than `_https-json.cjs`'s 15s default;
// `inspect-image.cjs` overrides to 10s for the same reasons (registry
// queries should be fast; longer waits indicate a hung registry).
const REQUEST_TIMEOUT_MS = 10_000;

// Heuristic table: image base name or resolved Cmd/Entrypoint contains
// one of these tokens → suggest the corresponding tmpfs paths. Sourced
// from barney/src/config/exampleApps.ts. Order: longer/more-specific
// tokens first when there's ambiguity.
const TMPFS_HINTS: ReadonlyArray<{
  readonly match: string;
  readonly paths: readonly string[];
}> = [
  { match: 'wordpress', paths: ['/run/lock', '/var/run/apache2'] },
  { match: 'mariadb', paths: ['/run/mysqld'] },
  { match: 'postgres', paths: ['/var/run/postgresql'] },
  { match: 'mysql', paths: ['/var/run/mysqld'] },
  { match: 'nginx', paths: ['/var/cache/nginx', '/var/run'] },
];

export interface ImageInfo {
  image: string;
  digest: string | null;
  ports: string[];
  env: Record<string, string>;
  cmd: string[] | null;
  entrypoint: string[] | null;
  user: string;
  workingDir: string;
  healthcheck: Record<string, unknown> | null;
  labels: Record<string, string> | null;
  volumes: Record<string, unknown> | null;
  suggestedTmpfs: string[];
}

export interface InspectImageOptions {
  /**
   * HTTP client. **Production callers SHOULD use the default** (which is
   * `createGuardedFetch()`, blocking RFC 1918 / loopback / link-local /
   * metadata at connect time). Tests pass canned implementations.
   * Browser/Deno consumers pass their own SSRF-guarded fetch since
   * `createGuardedFetch()` throws on non-Node runtimes.
   */
  fetch?: typeof fetch;
  /** Sink for fail-soft diagnostics. Defaults to `console.warn`. */
  logger?: (reason: string) => void;
}

const defaultLogger: (reason: string) => void = (reason) => {
  console.warn(reason);
};

interface ParsedRef {
  registry: string;
  name: string;
  tag: string | null;
  digest: string | null;
}

export async function inspectImage(
  imageRef: string,
  opts: InspectImageOptions = {},
): Promise<ImageInfo | null> {
  const logger = opts.logger ?? defaultLogger;
  const fetchImpl: typeof fetch = opts.fetch ?? createDefaultGuardedFetch();

  let parsed: ParsedRef;
  try {
    parsed = parseRef(imageRef);
  } catch (err) {
    logger(
      `inspect-image: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const ref = parsed.digest ?? parsed.tag ?? 'latest';
  try {
    let authHeader: string | null = null;
    if (parsed.registry === 'docker.io') {
      const token = await getDockerHubToken(parsed.name, fetchImpl);
      authHeader = `Bearer ${token}`;
    }

    // Step 1: fetch manifest (may be an index → pick platform → refetch).
    let manifestRes = await fetchManifest(
      parsed.registry,
      parsed.name,
      ref,
      authHeader,
      fetchImpl,
    );
    if (
      manifestRes.contentType.includes('manifest.list') ||
      manifestRes.contentType.includes('image.index') ||
      isManifestIndex(manifestRes.manifest)
    ) {
      const child = pickPlatformManifest(manifestRes.manifest);
      if (!child || typeof child.digest !== 'string') {
        throw new Error('multi-arch index has no usable child manifest');
      }
      manifestRes = await fetchManifest(
        parsed.registry,
        parsed.name,
        child.digest,
        authHeader,
        fetchImpl,
      );
    }

    // Step 2: fetch the config blob — the actual image config lives there.
    const config = manifestRes.manifest.config as
      | { digest?: unknown }
      | undefined;
    if (!config || typeof config.digest !== 'string') {
      throw new Error('manifest has no config descriptor');
    }
    const configBlob = await fetchBlobJson(
      parsed.registry,
      parsed.name,
      config.digest,
      authHeader,
      fetchImpl,
    );
    const c = (configBlob.config ?? {}) as Record<string, unknown>;

    const out: ImageInfo = {
      image: `${parsed.registry}/${parsed.name}${parsed.digest ? '@' + parsed.digest : ':' + (parsed.tag ?? 'latest')}`,
      digest: manifestRes.digest ?? parsed.digest ?? null,
      ports: pickPorts(c.ExposedPorts),
      env: parseEnv(c.Env),
      cmd: Array.isArray(c.Cmd) ? (c.Cmd as string[]) : null,
      entrypoint: Array.isArray(c.Entrypoint)
        ? (c.Entrypoint as string[])
        : null,
      user: typeof c.User === 'string' ? c.User : '',
      workingDir: typeof c.WorkingDir === 'string' ? c.WorkingDir : '',
      healthcheck:
        c.Healthcheck !== null &&
        typeof c.Healthcheck === 'object' &&
        !Array.isArray(c.Healthcheck)
          ? (c.Healthcheck as Record<string, unknown>)
          : null,
      labels:
        c.Labels !== null &&
        typeof c.Labels === 'object' &&
        !Array.isArray(c.Labels)
          ? (c.Labels as Record<string, string>)
          : null,
      volumes:
        c.Volumes !== null &&
        typeof c.Volumes === 'object' &&
        !Array.isArray(c.Volumes)
          ? (c.Volumes as Record<string, unknown>)
          : null,
      suggestedTmpfs: [],
    };
    out.suggestedTmpfs = suggestedTmpfsFor(parsed.name, [
      ...(out.cmd ?? []),
      ...(out.entrypoint ?? []),
    ]);

    return out;
  } catch (err) {
    logger(`inspect-image: ${formatErrorChain(err)}`);
    return null;
  }
}

/**
 * Walk an Error's `cause` chain and join all message strings. undici wraps
 * connection errors (including SSRF blocks from our custom Dispatcher) in
 * a fetch-side TypeError with the underlying cause nested via `.cause`.
 * Surfacing the chain in the logger gives the user the real reason (e.g.,
 * "SSRF blocked: 127.0.0.1 ... loopback") instead of an opaque
 * "fetch failed".
 */
function formatErrorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  let depth = 0;
  // Defensive bound — sane Error chains are <5 levels; cap at 10 to avoid
  // pathological cycles.
  while (current !== null && current !== undefined && depth < 10) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
    depth += 1;
  }
  return parts.join(' | ');
}

let cachedDefaultFetch: typeof fetch | undefined;
function createDefaultGuardedFetch(): typeof fetch {
  if (!cachedDefaultFetch) {
    cachedDefaultFetch = createGuardedFetch();
  }
  return cachedDefaultFetch;
}

function parseRef(ref: string): ParsedRef {
  // "<reg>/<name>@sha256:<digest>" | "<reg>/<name>:<tag>" | "<name>" | "<name>:<tag>"
  let registry = 'docker.io';
  let name: string;
  let tag: string | null = null;
  let digest: string | null = null;

  let rest = ref;
  const atIdx = rest.indexOf('@');
  if (atIdx >= 0) {
    digest = rest.slice(atIdx + 1);
    rest = rest.slice(0, atIdx);
  }

  // Detect registry segment: head before first `/` is a registry only if
  // it has a `.` or `:` (port) or is `localhost`.
  const firstSlash = rest.indexOf('/');
  if (firstSlash > 0) {
    const head = rest.slice(0, firstSlash);
    if (head === 'localhost' || head.includes('.') || head.includes(':')) {
      registry = head;
      rest = rest.slice(firstSlash + 1);
    }
  }

  if (!digest) {
    const colonIdx = rest.lastIndexOf(':');
    if (colonIdx >= 0) {
      tag = rest.slice(colonIdx + 1);
      name = rest.slice(0, colonIdx);
    } else {
      name = rest;
      tag = 'latest';
    }
  } else {
    name = rest;
  }

  // Docker Hub library prefix for single-segment names ("nginx" → "library/nginx").
  if (registry === 'docker.io' && !name.includes('/')) {
    name = `library/${name}`;
  }

  // Validate URL-interpolated fields against OCI Distribution Spec grammar
  // BEFORE the URL is constructed. The ref strings reach the user via
  // `DeploySpec.image`, so malformed input must be rejected here.
  for (const component of name.split('/')) {
    if (!OCI_NAME_COMPONENT.test(component)) {
      throw new Error(`invalid name component "${component}" in image ref`);
    }
  }
  if (tag !== null && !OCI_TAG.test(tag)) {
    throw new Error(`invalid tag "${tag}" in image ref`);
  }
  if (digest !== null && !OCI_DIGEST.test(digest)) {
    throw new Error(
      `invalid digest "${digest}" in image ref (expected sha256:<64-hex>)`,
    );
  }

  return { registry, name, tag, digest };
}

function registryHost(registry: string): string {
  // Docker Hub's image API lives at registry-1.docker.io even though the
  // canonical "registry" name is docker.io.
  return registry === 'docker.io' ? 'registry-1.docker.io' : registry;
}

async function getDockerHubToken(
  name: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  // Docker Hub requires anonymous access still go through a token grant.
  // Surface 429 specifically — anonymous pulls are rate-limited per-IP
  // and a 60-min wait fixes it. Without this special case the user sees
  // the same fail-soft `null` outcome as a hard 401 with no signal that
  // the situation is temporary.
  const res = await capturingFetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${name}:pull`,
    {},
    fetchImpl,
  );
  if (res.status === 429) {
    throw new Error(
      'Docker Hub token: HTTP 429 (anonymous pulls rate-limited per-IP; retry after ~60 min, or authenticate)',
    );
  }
  if (res.status !== 200) {
    throw new Error(`Docker Hub token: HTTP ${res.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error('Docker Hub token: invalid JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { token?: unknown }).token !== 'string'
  ) {
    throw new Error('Docker Hub token: missing `token` in response');
  }
  return (parsed as { token: string }).token;
}

async function fetchManifest(
  registry: string,
  name: string,
  ref: string,
  authHeader: string | null,
  fetchImpl: typeof fetch,
): Promise<{
  manifest: Record<string, unknown>;
  contentType: string;
  digest: string | null;
}> {
  const host = registryHost(registry);
  const url = `https://${host}/v2/${name}/manifests/${ref}`;
  const headers: Record<string, string> = { Accept: ACCEPT_MANIFEST };
  if (authHeader) headers.Authorization = authHeader;
  const res = await capturingFetch(url, { headers }, fetchImpl);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `registry returned ${res.status} on manifest fetch (auth required? private registry?)`,
    );
  }
  if (res.status === 404) {
    // Digest-pinned refs use `@sha256:...`; tag refs use `:tag`. Pick the
    // right separator so the error message doesn't show
    // `registry/name:sha256:...` mistakenly.
    const sep = ref.startsWith('sha256:') ? '@' : ':';
    throw new Error(`image not found: ${registry}/${name}${sep}${ref}`);
  }
  if (res.status !== 200) {
    throw new Error(`registry returned ${res.status} on manifest fetch`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error('manifest is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest is not a JSON object');
  }
  return {
    manifest: parsed as Record<string, unknown>,
    contentType: res.headers.get('content-type') ?? '',
    digest: res.headers.get('docker-content-digest'),
  };
}

async function fetchBlobJson(
  registry: string,
  name: string,
  digest: string,
  authHeader: string | null,
  fetchImpl: typeof fetch,
): Promise<{ config?: unknown }> {
  const host = registryHost(registry);
  const url = `https://${host}/v2/${name}/blobs/${digest}`;
  const headers: Record<string, string> = {};
  if (authHeader) headers.Authorization = authHeader;
  // undici fetch follows redirects by default; registries 307 → CDN.
  const res = await capturingFetch(url, { headers }, fetchImpl);
  if (res.status !== 200) {
    throw new Error(`registry returned ${res.status} on blob fetch`);
  }
  try {
    return JSON.parse(res.body) as { config?: unknown };
  } catch {
    throw new Error('blob is not valid JSON');
  }
}

interface CapturedResponse {
  status: number;
  headers: Headers;
  body: string;
}

/**
 * Wrap fetch with `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` and a streamed
 * body-size cap. Throws on overflow, timeout, or read error so the outer
 * try/catch produces the fail-soft `null` return.
 */
async function capturingFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<CapturedResponse> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`request timeout on ${url}`);
    }
    throw err;
  }
  // Stream the body with a manual chunk-accumulation cap. Avoids the
  // unbounded `await response.text()` path that would let a hostile
  // registry exhaust memory.
  const reader = response.body?.getReader();
  if (!reader) {
    return { status: response.status, headers: response.headers, body: '' };
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error(
            `response body exceeded ${MAX_BODY_BYTES} bytes (cap) on ${url}`,
          );
        }
        chunks.push(value);
      }
    }
    body = decoder.decode(concatUint8Arrays(chunks));
  } finally {
    reader.releaseLock();
  }
  return { status: response.status, headers: response.headers, body };
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) {
    const only = chunks[0];
    if (only !== undefined) return only;
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function pickPorts(exposedPorts: unknown): string[] {
  if (
    exposedPorts === null ||
    typeof exposedPorts !== 'object' ||
    Array.isArray(exposedPorts)
  ) {
    return [];
  }
  return Object.keys(exposedPorts as Record<string, unknown>).sort();
}

function parseEnv(env: unknown): Record<string, string> {
  if (!Array.isArray(env)) return {};
  const out: Record<string, string> = {};
  for (const kv of env) {
    if (typeof kv !== 'string') continue;
    const i = kv.indexOf('=');
    if (i > 0) {
      const key = kv.slice(0, i);
      const value = kv.slice(i + 1);
      out[key] = value;
    } else {
      out[kv] = '';
    }
  }
  return out;
}

function isManifestIndex(m: Record<string, unknown>): boolean {
  return Array.isArray(m.manifests);
}

function pickPlatformManifest(
  index: Record<string, unknown>,
): Record<string, unknown> | null {
  const list = index.manifests;
  if (!Array.isArray(list)) return null;
  const linuxAmd64 = list.find(
    (m): m is Record<string, unknown> =>
      m !== null &&
      typeof m === 'object' &&
      (m as { platform?: unknown }).platform !== null &&
      typeof (m as { platform?: unknown }).platform === 'object' &&
      (m as { platform: { os?: unknown } }).platform.os === 'linux' &&
      (m as { platform: { architecture?: unknown } }).platform.architecture ===
        'amd64',
  );
  if (linuxAmd64) return linuxAmd64;
  // Fall back to first entry.
  const first = list[0];
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    return first as Record<string, unknown>;
  }
  return null;
}

function suggestedTmpfsFor(
  name: string,
  cmdAndEntrypoint: ReadonlyArray<string>,
): string[] {
  const haystack = [name, ...cmdAndEntrypoint].join(' ').toLowerCase();
  for (const hint of TMPFS_HINTS) {
    if (haystack.includes(hint.match)) return [...hint.paths];
  }
  return [];
}
