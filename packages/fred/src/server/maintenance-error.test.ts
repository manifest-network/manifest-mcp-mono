import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import { ProviderApiError } from '../http/provider.js';
import { maintenanceRequestError } from '../maintenance-error.js';
import { maintenanceToolError } from './maintenance-error.js';

describe('MCP legacy maintenance recovery guidance', () => {
  it.each(['restart', 'update'] as const)(
    'exposes the %s recovery cause without a key',
    (operation) => {
      const error = maintenanceRequestError(
        new ProviderApiError(409, 'busy'),
        'lease',
        undefined,
        operation,
      );
      const result = maintenanceToolError(error, 'lease', operation);
      expect(result).toBe((error as Error & { cause?: unknown }).cause);
      expect(result).toMatchObject({
        code: 'MAINTENANCE_REQUEST_FAILED',
        details: { provider_status: 409, operation, outcome: 'unknown' },
      });
      expect((result as ManifestMCPError).details).not.toHaveProperty(
        'idempotency_key',
      );
    },
  );

  it('does not promote a mismatched command or an unrelated error', () => {
    const error = maintenanceRequestError(
      new ProviderApiError(503, 'busy'),
      'lease',
      undefined,
      'restart',
    );
    expect(maintenanceToolError(error, 'other', 'restart')).toBe(error);
    expect(maintenanceToolError(error, 'lease', 'update')).toBe(error);
    const unrelated = new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_CONFIG,
      'bad configuration',
    );
    expect(maintenanceToolError(unrelated, 'lease', 'restart')).toBe(unrelated);
    expect(maintenanceToolError(null, 'lease', 'restart')).toBe(null);
  });

  it('preserves modern command errors and hostile diagnostic objects', () => {
    const modern = maintenanceRequestError(
      new ProviderApiError(409, 'busy'),
      'lease',
      '01c676aa-6609-436f-9da4-321f574992b0',
      'restart',
    );
    expect(maintenanceToolError(modern, 'lease', 'restart')).toBe(modern);
    const hostile = new ProviderApiError(503, 'unavailable');
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('broken diagnostic');
      },
    });
    expect(maintenanceToolError(hostile, 'lease', 'restart')).toBe(hostile);
  });
});
