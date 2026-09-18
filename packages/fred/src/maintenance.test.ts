import { ManifestMCPError } from '@manifest-network/manifest-mcp-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMaintenanceIdempotencyKey,
  resolveMaintenanceIdempotencyKey,
} from './maintenance.js';

const COMMAND_KEY = '77228fd4-4149-4981-83a8-21b4f6a2f681';

afterEach(() => vi.unstubAllGlobals());

describe('maintenance idempotency keys', () => {
  it('uses the platform UUID generator when available', () => {
    const randomUUID = vi.fn(() => COMMAND_KEY);
    vi.stubGlobal('crypto', { randomUUID });
    expect(createMaintenanceIdempotencyKey()).toBe(COMMAND_KEY);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it.each([
    [0, '00000000-0000-4000-8000-000000000000'],
    [255, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ])(
    'sets UUIDv4 bits on browser random bytes filled with %i',
    (value, key) => {
      const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(value));
      vi.stubGlobal('crypto', { getRandomValues });
      expect(createMaintenanceIdempotencyKey()).toBe(key);
      expect(getRandomValues).toHaveBeenCalledOnce();
      expect(getRandomValues.mock.calls[0][0]).toHaveLength(16);
    },
  );

  it('uses fresh random bytes for each implicit command key', () => {
    let value = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(value++),
    });
    const first = resolveMaintenanceIdempotencyKey();
    const second = resolveMaintenanceIdempotencyKey();
    expect(first).not.toBe(second);
    expect(first).toMatch(/-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
    expect(second).toMatch(/-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });

  it.each([
    undefined,
    {},
    {
      getRandomValues: () => {
        throw new Error('entropy unavailable');
      },
    },
  ])('reports unavailable secure randomness as INVALID_CONFIG', (crypto) => {
    vi.stubGlobal('crypto', crypto);
    expect(createMaintenanceIdempotencyKey).toThrow(ManifestMCPError);
    expect(createMaintenanceIdempotencyKey).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
    expect(resolveMaintenanceIdempotencyKey(COMMAND_KEY)).toBe(COMMAND_KEY);
  });

  it('validates caller keys without needing platform crypto', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => resolveMaintenanceIdempotencyKey('invalid')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});
