import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import { buildManifestPreview } from './buildManifestPreview.js';

describe('buildManifestPreview', () => {
  describe('mode selection', () => {
    it('rejects when no input mode is provided', async () => {
      await expect(buildManifestPreview({})).rejects.toBeInstanceOf(
        ManifestMCPError,
      );
    });

    it('rejects manifest + structured fields together', async () => {
      await expect(
        buildManifestPreview({
          manifest: '{"image":"nginx"}',
          image: 'redis',
          port: 6379,
        }),
      ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    });

    it('rejects services + image together', async () => {
      await expect(
        buildManifestPreview({
          image: 'nginx',
          port: 80,
          services: { web: { image: 'nginx' } },
        }),
      ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    });

    it('rejects empty services (hard structural failure per docstring)', async () => {
      // Without this guard, services={} silently round-trips into a
      // single-service classification with confusing per-field errors.
      await expect(
        buildManifestPreview({ services: {} }),
      ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    });

    it('rejects image without port', async () => {
      await expect(
        buildManifestPreview({ image: 'nginx' }),
      ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    });
  });

  describe('structured single-service mode', () => {
    it('builds, hashes, and validates an nginx manifest', async () => {
      const result = await buildManifestPreview({
        image: 'nginx:1.25',
        port: 80,
        env: { LOG_LEVEL: 'info' },
      });

      expect(result.format).toBe('single');
      expect(result.validation.valid).toBe(true);
      expect(result.validation.errors).toHaveLength(0);
      expect(result.meta_hash_hex).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(result.manifest_json)).toEqual({
        image: 'nginx:1.25',
        ports: { '80/tcp': {} },
        env: { LOG_LEVEL: 'info' },
      });
    });

    it('produces a deterministic meta_hash for equivalent inputs', async () => {
      const a = await buildManifestPreview({ image: 'nginx', port: 80 });
      const b = await buildManifestPreview({ image: 'nginx', port: 80 });
      expect(a.meta_hash_hex).toBe(b.meta_hash_hex);
    });

    it('returns validation errors for blocked env names', async () => {
      const result = await buildManifestPreview({
        image: 'nginx',
        port: 80,
        env: { PATH: '/bin' },
      });
      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('PATH'))).toBe(
        true,
      );
    });
  });

  describe('structured stack mode', () => {
    it('builds a stack manifest with services', async () => {
      const result = await buildManifestPreview({
        services: {
          web: { image: 'nginx', ports: { '80/tcp': {} } },
          db: {
            image: 'postgres:16',
            env: { POSTGRES_PASSWORD: 'x' },
            health_check: { test: ['CMD', 'pg_isready'] },
          },
        },
      });

      expect(result.format).toBe('stack');
      expect(result.validation.valid).toBe(true);
      expect(result.manifest).toMatchObject({
        services: {
          web: expect.any(Object),
          db: expect.any(Object),
        },
      });
    });

    it('flags invalid service names in validation result', async () => {
      const result = await buildManifestPreview({
        services: { Web: { image: 'nginx' } },
      });
      expect(result.validation.valid).toBe(false);
      expect(
        result.validation.errors.some((e) => e.toLowerCase().includes('rfc')),
      ).toBe(true);
    });
  });

  describe('raw manifest mode', () => {
    it('parses and validates a raw JSON string', async () => {
      const result = await buildManifestPreview({
        manifest: JSON.stringify({ image: 'redis:7' }),
      });
      expect(result.format).toBe('single');
      expect(result.validation.valid).toBe(true);
    });

    it('throws on invalid JSON', async () => {
      await expect(
        buildManifestPreview({ manifest: '{not json' }),
      ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    });

    it('throws when JSON is not an object', async () => {
      await expect(
        buildManifestPreview({ manifest: '"just a string"' }),
      ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    });

    it('returns validation errors for unknown fields without throwing', async () => {
      const result = await buildManifestPreview({
        manifest: JSON.stringify({ image: 'nginx', volumes: ['/data'] }),
      });
      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors.some((e) => e.includes('volumes'))).toBe(
        true,
      );
      // The hash + JSON are still produced — the agent can decide whether to
      // continue (e.g., when validation flags a future-spec field).
      expect(result.meta_hash_hex).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
