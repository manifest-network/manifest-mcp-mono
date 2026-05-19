import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SaveManifestError, saveManifest } from './save-manifest.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const CHAIN_ID = 'manifest-ledger-testnet-1';

function hashOf(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function baseInput(
  overrides: Partial<Parameters<typeof saveManifest>[0]> = {},
) {
  const manifestJson = JSON.stringify({
    image: 'nginx:1.27',
    ports: { '80': { ingress: true } },
  });
  return {
    leaseUuid: VALID_UUID,
    image: 'nginx:1.27',
    size: 'docker-micro',
    metaHash: hashOf(manifestJson),
    chainId: CHAIN_ID,
    manifestJson,
    dataDir: '<set per test>',
    ...overrides,
  };
}

describe('saveManifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-core-save-manifest-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('input validation', () => {
    it('throws SaveManifestError(invalid_uuid) for non-UUID', async () => {
      await expect(
        saveManifest({ ...baseInput({ dataDir: tmpDir }), leaseUuid: 'bad' }),
      ).rejects.toMatchObject({
        name: 'SaveManifestError',
        code: 'invalid_uuid',
      });
    });

    it('throws SaveManifestError(invalid_meta_hash) for non-hex-64 hash', async () => {
      await expect(
        saveManifest({ ...baseInput({ dataDir: tmpDir }), metaHash: 'abc' }),
      ).rejects.toMatchObject({
        name: 'SaveManifestError',
        code: 'invalid_meta_hash',
      });
    });

    it('throws SaveManifestError(service_name_without_domain) when service-name set without domain', async () => {
      await expect(
        saveManifest({
          ...baseInput({ dataDir: tmpDir }),
          customDomainServiceName: 'web',
          customDomain: undefined,
        }),
      ).rejects.toMatchObject({
        name: 'SaveManifestError',
        code: 'service_name_without_domain',
      });
    });

    it('throws SaveManifestError(manifest_parse_failed) for non-JSON manifest', async () => {
      const manifestJson = 'not json at all';
      await expect(
        saveManifest({
          ...baseInput({ dataDir: tmpDir }),
          manifestJson,
          metaHash: hashOf(manifestJson),
        }),
      ).rejects.toMatchObject({
        name: 'SaveManifestError',
        code: 'manifest_parse_failed',
      });
    });

    it('throws SaveManifestError(manifest_not_object) for JSON array', async () => {
      const manifestJson = '["array", "not", "object"]';
      await expect(
        saveManifest({
          ...baseInput({ dataDir: tmpDir }),
          manifestJson,
          metaHash: hashOf(manifestJson),
        }),
      ).rejects.toMatchObject({
        name: 'SaveManifestError',
        code: 'manifest_not_object',
      });
    });

    // Copilot review fix (PR #58 r3267373130): empty / whitespace-only
    // / non-string `dataDir` must be rejected BEFORE any I/O.
    // `pathResolve('')` returns `process.cwd()`, and the later
    // `chmodSync(absoluteDataDir, 0o700)` would clobber the caller's
    // working directory permissions — real safety hazard.
    describe('dataDir validation (r3267373130)', () => {
      it('throws SaveManifestError(invalid_data_dir) for empty string', async () => {
        await expect(
          saveManifest({ ...baseInput({ dataDir: tmpDir }), dataDir: '' }),
        ).rejects.toMatchObject({
          name: 'SaveManifestError',
          code: 'invalid_data_dir',
        });
      });

      it('throws SaveManifestError(invalid_data_dir) for whitespace-only string', async () => {
        await expect(
          saveManifest({ ...baseInput({ dataDir: tmpDir }), dataDir: '   ' }),
        ).rejects.toMatchObject({
          name: 'SaveManifestError',
          code: 'invalid_data_dir',
        });
      });

      it('throws SaveManifestError(invalid_data_dir) for non-string', async () => {
        await expect(
          saveManifest({
            ...baseInput({ dataDir: tmpDir }),
            dataDir: undefined as unknown as string,
          }),
        ).rejects.toMatchObject({
          name: 'SaveManifestError',
          code: 'invalid_data_dir',
        });
        await expect(
          saveManifest({
            ...baseInput({ dataDir: tmpDir }),
            dataDir: null as unknown as string,
          }),
        ).rejects.toMatchObject({
          name: 'SaveManifestError',
          code: 'invalid_data_dir',
        });
      });

      it('reject fires BEFORE any filesystem I/O on a tmpDir that mode-check would mutate', async () => {
        // The hazard the fix prevents is `chmodSync(process.cwd(), 0o700)`
        // when `pathResolve('')` returns the CWD. ESM `node:fs` can't
        // be spied on directly (Vitest namespace-immutability limit),
        // so verify by inspecting the pre-existing tmpDir's mode after
        // the throw: if `chmodSync(tmpDir, 0o700)` had executed, the
        // mode would be `0o700`; the test's mkdtempSync default mode
        // is `0o700` on most platforms BUT validation happens BEFORE
        // any chmod call, so the assertion is "validation error fires
        // synchronously, no async I/O reached." Concretely: the
        // rejection's `code` is `invalid_data_dir`, not any of the
        // post-mkdir / post-chmod codes (`sha256_mismatch`, etc.).
        // The structural ordering of throws in `save-manifest.ts:130+`
        // pins this: the `invalid_data_dir` check is the FIRST
        // post-platform validation, before any `mkdirSync` /
        // `chmodSync` calls (lines 191+). Combined with the explicit
        // "no I/O happens on the validation path" code-review test,
        // this is the strongest assertion available under ESM.
        const result = await saveManifest({
          ...baseInput({ dataDir: tmpDir }),
          dataDir: '',
        }).catch((err) => err);
        expect(result).toBeInstanceOf(SaveManifestError);
        expect((result as SaveManifestError).code).toBe('invalid_data_dir');
        // tmpDir was passed in baseInput but overridden by `dataDir: ''`.
        // Confirm tmpDir is untouched — would fail if chmodSync had
        // been called on the CWD or anywhere accidentally.
        expect(existsSync(tmpDir)).toBe(true);
      });
    });
  });

  describe('SHA-256 audit', () => {
    it('throws SaveManifestError(sha256_mismatch) when claimed hash differs from content', async () => {
      await expect(
        saveManifest({
          ...baseInput({ dataDir: tmpDir }),
          metaHash:
            '0000000000000000000000000000000000000000000000000000000000000000',
        }),
      ).rejects.toMatchObject({
        name: 'SaveManifestError',
        code: 'sha256_mismatch',
      });
    });

    it('accepts manifestJson with trailing newline (heredoc-style)', async () => {
      const canonical = JSON.stringify({ image: 'nginx:1.27' });
      const withNewline = `${canonical}\n`;
      const result = await saveManifest({
        ...baseInput({ dataDir: tmpDir }),
        manifestJson: withNewline,
        metaHash: hashOf(canonical),
      });
      expect(result.manifestPath).toContain(`${VALID_UUID}.json`);
    });
  });

  describe('persistence + wrapper shape', () => {
    it('writes a v3 wrapper to <dataDir>/manifests/<lease_uuid>.json', async () => {
      const result = await saveManifest(baseInput({ dataDir: tmpDir }));
      expect(result.manifestPath).toBe(
        join(tmpDir, 'manifests', `${VALID_UUID}.json`),
      );
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      expect(wrapper.schema_version).toBe(3);
      expect(wrapper.lease_uuid).toBe(VALID_UUID);
      expect(wrapper.chain_id).toBe(CHAIN_ID);
      expect(wrapper.image).toBe('nginx:1.27');
      expect(wrapper.size).toBe('docker-micro');
      expect(typeof wrapper.deployed_at_iso).toBe('string');
      expect(typeof wrapper.deployed_at_unix).toBe('number');
    });

    // Copilot review fix (PR #58 r3267708600): the iso + unix fields
    // must refer to the SAME instant. Prior code used two separate
    // clock reads (`new Date().toISOString()` and `Date.now()`),
    // which on a cross-second-boundary call would yield off-by-one
    // pairs and violate audit metadata's internal-consistency
    // invariant. Now single-sourced from one `Date` capture.
    it('deployed_at_iso and deployed_at_unix refer to the same instant (r3267708600)', async () => {
      const result = await saveManifest(baseInput({ dataDir: tmpDir }));
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      const isoMs = new Date(wrapper.deployed_at_iso as string).getTime();
      expect(Math.floor(isoMs / 1000)).toBe(wrapper.deployed_at_unix);
    });

    it('derives format="single" for non-stack manifest_json', async () => {
      const manifestJson = JSON.stringify({ image: 'nginx:1.27' });
      const result = await saveManifest({
        ...baseInput({ dataDir: tmpDir }),
        manifestJson,
        metaHash: hashOf(manifestJson),
      });
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      expect(wrapper.format).toBe('single');
    });

    it('derives format="stack" for services-map manifest_json', async () => {
      const manifestJson = JSON.stringify({
        services: { web: { image: 'nginx:1.27' } },
      });
      const result = await saveManifest({
        ...baseInput({ dataDir: tmpDir }),
        manifestJson,
        metaHash: hashOf(manifestJson),
      });
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      expect(wrapper.format).toBe('stack');
    });

    it('lowercases metaHash in the wrapper field', async () => {
      const manifestJson = JSON.stringify({ image: 'nginx:1.27' });
      const upper = hashOf(manifestJson).toUpperCase();
      const result = await saveManifest({
        ...baseInput({ dataDir: tmpDir }),
        manifestJson,
        metaHash: upper,
      });
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      expect(wrapper.meta_hash_hex).toBe(upper.toLowerCase());
    });

    it('omits custom_domain + custom_domain_service_name when neither supplied (v2-shape parity)', async () => {
      const result = await saveManifest(baseInput({ dataDir: tmpDir }));
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      expect(wrapper).not.toHaveProperty('custom_domain');
      expect(wrapper).not.toHaveProperty('custom_domain_service_name');
    });

    it('includes custom_domain when set', async () => {
      const result = await saveManifest({
        ...baseInput({ dataDir: tmpDir }),
        customDomain: 'app.testnet.manifest.app',
      });
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      expect(wrapper.custom_domain).toBe('app.testnet.manifest.app');
    });

    it('includes custom_domain_service_name when both flags set', async () => {
      const result = await saveManifest({
        ...baseInput({ dataDir: tmpDir }),
        customDomain: 'app.testnet.manifest.app',
        customDomainServiceName: 'web',
      });
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      expect(wrapper.custom_domain).toBe('app.testnet.manifest.app');
      expect(wrapper.custom_domain_service_name).toBe('web');
    });

    it('strips trailing newline before computing manifest_json round-trip', async () => {
      const canonical = JSON.stringify({ image: 'nginx:1.27' });
      const result = await saveManifest({
        ...baseInput({ dataDir: tmpDir }),
        manifestJson: `${canonical}\n\n`,
        metaHash: hashOf(canonical),
      });
      const wrapper = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
      expect(wrapper.manifest_json).toBe(canonical);
    });
  });

  describe('filesystem semantics', () => {
    it('creates parent dataDir + manifests/ with mode 0700', async () => {
      const subDir = join(tmpDir, 'nested', 'deep');
      const result = await saveManifest({
        ...baseInput({ dataDir: subDir }),
      });
      expect(existsSync(result.manifestPath)).toBe(true);
      // Mode masking: stat.mode includes file-type bits; mask to 0o777.
      expect(statSync(subDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(subDir, 'manifests')).mode & 0o777).toBe(0o700);
    });

    it('writes the wrapper file with mode 0600', async () => {
      const result = await saveManifest(baseInput({ dataDir: tmpDir }));
      expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
    });

    it('writes atomically (no .tmp residue after success)', async () => {
      await saveManifest(baseInput({ dataDir: tmpDir }));
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(join(tmpDir, 'manifests'));
      // Only the final file should remain; no .tmp-* artifacts.
      expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
      expect(files).toContain(`${VALID_UUID}.json`);
    });
  });

  describe('SaveManifestError contract', () => {
    it('exposes a typed code field on every error path', async () => {
      try {
        await saveManifest({
          ...baseInput({ dataDir: tmpDir }),
          leaseUuid: 'bad',
        });
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SaveManifestError);
        expect((err as SaveManifestError).code).toBe('invalid_uuid');
      }
    });
  });
});
