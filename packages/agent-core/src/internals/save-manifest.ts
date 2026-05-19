/**
 * Persist a deployed manifest as a schema-version-3 wrapper to disk.
 *
 * Port of `manifest-agent-plugin/scripts/save-manifest.cjs` (plugin git-hash
 * `3a33e80`) with one architectural divergence: target directory is a
 * **function argument** (`dataDir: string`) rather than an env-var read.
 * Per gate-1 verdict, agent-core's `platform: 'neutral'` build target
 * forbids env-var reads at this layer; the orchestrator (or plugin glue
 * code) is responsible for resolving the manifests dir from its own env
 * context and passing it in.
 *
 * **Wrapper shape (schema_version 3):**
 *
 * ```
 * {
 *   schema_version: 3,
 *   lease_uuid, deployed_at_iso, deployed_at_unix,
 *   chain_id, image, size, meta_hash_hex,
 *   format,                        // "single" or "stack"
 *   manifest_json,                 // string — canonical Fred-rendered JSON
 *   custom_domain?,                // (v3) FQDN attached to the lease item
 *   custom_domain_service_name?    // (v3) stack-lease service holder
 * }
 * ```
 *
 * Schema-version compat: v2 wrappers remain readable by all downstream
 * helpers; missing v3 fields are tolerated as undefined.
 *
 * **Audit guarantee:** SHA-256 of the bytes about to be persisted (after
 * normalizing the heredoc-/Write-added trailing newline) MUST equal
 * `metaHash`. Catches paste errors, accidental spec-vs-manifest_json
 * swaps, and transit corruption. Mismatch throws a typed
 * `SaveManifestError` (`code: 'sha256_mismatch'`).
 *
 * **Filesystem layout:** `<dataDir>/manifests/<lease_uuid>.json` with
 * mode 0600; parent `<dataDir>` and `<dataDir>/manifests` ensured at
 * mode 0700 (chmod-tightens an existing parent that was previously
 * looser).
 *
 * **Dynamic node-import discipline** (mirrors `guarded-fetch.ts`): the
 * `node:fs` / `node:path` / `node:crypto` imports are deferred to call
 * time so module load doesn't violate the `platform: 'neutral'` build
 * target. A `typeof process` check throws a clear "Node-only API" error
 * if invoked outside a Node-like runtime.
 */

/** SHA-256 hex digest — 64 lowercase hex chars. */
const META_HASH_RE = /^[0-9a-f]{64}$/i;

/** RFC 4122 UUID — 36 chars. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Input contract for `saveManifest`. All `*Hex` / UUID fields are validated. */
export interface SaveManifestInput {
  /** Validated lease UUID (RFC 4122 v1-v5). */
  leaseUuid: string;
  /** Canonical primary image reference (for the wrapper's `image` field). */
  image: string;
  /** SKU name (e.g. `docker-micro`) for the wrapper's `size` field. */
  size: string;
  /** SHA-256 hex of the canonical manifest JSON, from `build_manifest_preview`. */
  metaHash: string;
  /** Chain ID — e.g. `manifest-ledger-testnet-1`. */
  chainId: string;
  /**
   * Canonical Fred-rendered manifest JSON (as a STRING, not a parsed
   * object). The SHA-256 of these bytes (after trimming trailing
   * whitespace) MUST equal `metaHash`.
   */
  manifestJson: string;
  /**
   * Target data directory — the function writes
   * `<dataDir>/manifests/<lease_uuid>.json`. Per gate-1 verdict,
   * supplied by the caller (no env-var read).
   *
   * **MUST be a dedicated manifest-storage directory.** This function
   * `chmod`-tightens any pre-existing `dataDir` (and its `manifests/`
   * subdirectory) to mode `0o700`, matching the CJS source's security
   * posture. Do NOT pass shared parents like `$HOME`, `~/.config`, or
   * a generic data root — doing so would tighten those directories'
   * permissions and potentially break other processes that depend on
   * them. Plugin / Barney call sites must resolve this to a dedicated
   * subdirectory (e.g. `$XDG_DATA_HOME/manifest-agent/` or
   * `$MANIFEST_PLUGIN_DATA/`); the `manifests/` subdir is created
   * inside automatically.
   */
  dataDir: string;
  /** Optional custom-domain FQDN attached to the lease item. */
  customDomain?: string;
  /**
   * Optional stack-lease service name that holds the custom domain.
   * Meaningless without `customDomain`; throws if supplied alone.
   */
  customDomainServiceName?: string;
}

export interface SaveManifestResult {
  /** Absolute path to the persisted wrapper. */
  manifestPath: string;
}

/** Typed error surface for the I/O + validation failure paths. */
export class SaveManifestError extends Error {
  readonly code:
    | 'sha256_mismatch'
    | 'manifest_not_object'
    | 'invalid_uuid'
    | 'invalid_meta_hash'
    | 'invalid_data_dir'
    | 'service_name_without_domain'
    | 'manifest_parse_failed'
    | 'platform_unsupported';

  constructor(code: SaveManifestError['code'], message: string) {
    super(message);
    this.name = 'SaveManifestError';
    this.code = code;
    Object.setPrototypeOf(this, SaveManifestError.prototype);
  }
}

/**
 * Persist the manifest wrapper. Returns the absolute output path.
 *
 * Throws `SaveManifestError` for shape / validation failures; lets raw
 * I/O errors (EACCES, ENOSPC, etc.) propagate so the orchestrator can
 * decide whether to suppress them per step-16's "save-fail → success
 * still returned" contract.
 */
export async function saveManifest(
  input: SaveManifestInput,
): Promise<SaveManifestResult> {
  if (
    typeof process === 'undefined' ||
    typeof process.versions?.node !== 'string'
  ) {
    throw new SaveManifestError(
      'platform_unsupported',
      'saveManifest: requires Node.js runtime (node:fs / node:crypto / node:path)',
    );
  }
  // Copilot review fix (PR #58 r3267373130): reject empty / whitespace-
  // only / non-string `dataDir` BEFORE any I/O. `pathResolve('')` returns
  // `process.cwd()`, and the later `chmodSync(absoluteDataDir, 0o700)`
  // would then tighten the caller's working directory — a real safety
  // hazard if a misconfigured env (`MANIFEST_DATA_DIR=""`) reaches
  // here. Failing fast at the boundary keeps the hazard from
  // materializing.
  if (typeof input.dataDir !== 'string' || input.dataDir.trim().length === 0) {
    throw new SaveManifestError(
      'invalid_data_dir',
      `saveManifest: dataDir must be a non-empty path; got ${
        typeof input.dataDir === 'string'
          ? `"${input.dataDir}"`
          : input.dataDir === null
            ? 'null'
            : typeof input.dataDir
      }.`,
    );
  }
  if (!UUID_RE.test(input.leaseUuid)) {
    throw new SaveManifestError(
      'invalid_uuid',
      `saveManifest: leaseUuid must be a UUID; got "${input.leaseUuid}"`,
    );
  }
  if (!META_HASH_RE.test(input.metaHash)) {
    throw new SaveManifestError(
      'invalid_meta_hash',
      `saveManifest: metaHash must be a 64-character SHA-256 hex digest; got "${input.metaHash}"`,
    );
  }
  if (input.customDomainServiceName && !input.customDomain) {
    throw new SaveManifestError(
      'service_name_without_domain',
      'saveManifest: customDomainServiceName requires customDomain',
    );
  }

  // Trim trailing newline (heredoc/Write convention) so the SHA-256 of the
  // persisted bytes matches the meta_hash_hex returned by
  // build_manifest_preview.
  const trimmed = input.manifestJson.trimEnd();

  // Parse for shape sanity + format derivation. Failures throw a typed
  // `SaveManifestError(manifest_parse_failed)` rather than the raw
  // SyntaxError.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SaveManifestError(
      'manifest_parse_failed',
      `saveManifest: manifestJson is not valid JSON: ${reason}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SaveManifestError(
      'manifest_not_object',
      'saveManifest: manifestJson must encode a JSON object',
    );
  }
  const parsedRec = parsed as Record<string, unknown>;
  const isStack =
    parsedRec.services !== null &&
    typeof parsedRec.services === 'object' &&
    !Array.isArray(parsedRec.services);
  const format: 'single' | 'stack' = isStack ? 'stack' : 'single';

  // Dynamic imports — node-only deps deferred per the `platform: 'neutral'`
  // build target. Mirrors `guarded-fetch.ts`'s lazy-init pattern.
  const { mkdirSync, chmodSync, writeFileSync, renameSync } = await import(
    'node:fs'
  );
  const { createHash, randomUUID } = await import('node:crypto');
  const { join, resolve: pathResolve } = await import('node:path');

  // SHA-256 audit: catches the most common foot-gun (passing the
  // structured spec where the canonical manifest_json was expected).
  const computedHash = createHash('sha256').update(trimmed).digest('hex');
  if (computedHash !== input.metaHash.toLowerCase()) {
    throw new SaveManifestError(
      'sha256_mismatch',
      `saveManifest: SHA-256 mismatch. metaHash claims ${input.metaHash} but manifestJson content hashes to ${computedHash}. The wrong content was probably written (e.g. the structured spec instead of the canonical manifest_json string).`,
    );
  }

  // C5 fix: resolve dataDir to absolute BEFORE constructing paths.
  // `SaveManifestResult.manifestPath` is documented as absolute; the
  // prior `join(input.dataDir, ...)` returned a relative path when the
  // caller passed a relative dataDir. `path.resolve()` normalizes
  // against the process CWD if input is relative; idempotent for
  // already-absolute inputs.
  const absoluteDataDir = pathResolve(input.dataDir);

  // Ensure dataDir + manifests/ exist with tight perms. chmod after mkdir
  // so a pre-existing looser parent gets tightened (mkdir won't chmod
  // existing dirs).
  const manifestsDir = join(absoluteDataDir, 'manifests');
  mkdirSync(absoluteDataDir, { recursive: true, mode: 0o700 });
  chmodSync(absoluteDataDir, 0o700);
  mkdirSync(manifestsDir, { recursive: true, mode: 0o700 });
  chmodSync(manifestsDir, 0o700);

  // Copilot review fix (PR #58 r3267708600): single-source the deploy
  // timestamp. The prior code called `new Date().toISOString()` and
  // `Math.floor(Date.now() / 1000)` separately — two distinct clock
  // reads. If the function spans a second boundary, the iso + unix
  // fields refer to different instants, violating the audit
  // metadata's internal-consistency invariant (any tooling cross-
  // checking the pair would flag the drift).
  const deployedAt = new Date();
  const wrapper: Record<string, unknown> = {
    schema_version: 3,
    lease_uuid: input.leaseUuid,
    deployed_at_iso: deployedAt.toISOString(),
    deployed_at_unix: Math.floor(deployedAt.getTime() / 1000),
    chain_id: input.chainId,
    image: input.image,
    size: input.size,
    meta_hash_hex: input.metaHash.toLowerCase(),
    format,
    manifest_json: trimmed,
  };
  if (input.customDomain) {
    wrapper.custom_domain = input.customDomain;
  }
  if (input.customDomainServiceName) {
    wrapper.custom_domain_service_name = input.customDomainServiceName;
  }

  const outPath = join(manifestsDir, `${input.leaseUuid}.json`);
  // Atomic write: temp file in same dir + rename. Survives crash mid-write
  // without leaving a partial file at the canonical name. The randomUUID
  // suffix avoids collisions if multiple concurrent saves target the same
  // lease (rare, but the CJS's atomicWrite helper uses the same pattern).
  const tmpPath = `${outPath}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, `${JSON.stringify(wrapper, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmpPath, outPath);

  return { manifestPath: outPath };
}
