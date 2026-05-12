import { describe, expect, it, vi } from 'vitest';
import {
  extractRunningEndpoints,
  formatEndpointAsIngress,
  formatEndpointAsUrl,
  hasRunningInstances,
} from './connection.js';

describe('extractRunningEndpoints', () => {
  it('returns [] for null / undefined / non-object', () => {
    expect(extractRunningEndpoints(null)).toEqual([]);
    expect(extractRunningEndpoints(undefined)).toEqual([]);
    expect(extractRunningEndpoints('not an object')).toEqual([]);
    expect(extractRunningEndpoints(42)).toEqual([]);
    expect(extractRunningEndpoints([])).toEqual([]);
  });

  it('extracts running instances with fqdn from top-level instances[]', () => {
    const out = extractRunningEndpoints({
      instances: [
        { status: 'running', fqdn: 'a.example.com' },
        { status: 'running', fqdn: 'b.example.com' },
      ],
    });
    expect(out).toEqual([{ fqdn: 'a.example.com' }, { fqdn: 'b.example.com' }]);
  });

  it('extracts running instances from connection.services.<name>.instances[]', () => {
    const out = extractRunningEndpoints({
      services: {
        web: { instances: [{ status: 'running', fqdn: 'web.example.com' }] },
        api: { instances: [{ status: 'running', fqdn: 'api.example.com' }] },
      },
    });
    expect(out).toEqual([
      { fqdn: 'web.example.com' },
      { fqdn: 'api.example.com' },
    ]);
  });

  it('handles both top-level and per-service in the same payload (deduped)', () => {
    const out = extractRunningEndpoints({
      instances: [{ status: 'running', fqdn: 'shared.example.com' }],
      services: {
        web: {
          instances: [
            { status: 'running', fqdn: 'shared.example.com' }, // dup — drop
            { status: 'running', fqdn: 'web.example.com' },
          ],
        },
      },
    });
    expect(out).toEqual([
      { fqdn: 'shared.example.com' },
      { fqdn: 'web.example.com' },
    ]);
  });

  it('skips instances without status=running', () => {
    const out = extractRunningEndpoints({
      instances: [
        { status: 'pending', fqdn: 'pending.example.com' },
        { status: 'running', fqdn: 'running.example.com' },
        { status: 'failed', fqdn: 'failed.example.com' },
      ],
    });
    expect(out).toEqual([{ fqdn: 'running.example.com' }]);
  });

  it('skips instances without fqdn (internal-only deploys)', () => {
    const out = extractRunningEndpoints({
      instances: [
        { status: 'running' /* no fqdn */ },
        { status: 'running', fqdn: '' /* empty */ },
        { status: 'running', fqdn: 'has-fqdn.example.com' },
      ],
    });
    expect(out).toEqual([{ fqdn: 'has-fqdn.example.com' }]);
  });

  it('legitimately returns [] when instances exist but none are running (no warning)', () => {
    // wait_for_app_ready hasn't returned yet; this is the "lease pending"
    // state — empty result is correct and must not log a warning.
    const logger = vi.fn();
    const out = extractRunningEndpoints(
      {
        instances: [{ status: 'pending', fqdn: 'soon.example.com' }],
      },
      { logger },
    );
    expect(out).toEqual([]);
    expect(logger).not.toHaveBeenCalled();
  });

  it('warns via injected logger when shape lacks both instances and services keys', () => {
    const logger = vi.fn();
    const out = extractRunningEndpoints(
      { something_else: 'unknown', endpoints: [] },
      { logger },
    );
    expect(out).toEqual([]);
    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0]?.[0]).toMatch(/unrecognized shape/);
    expect(logger.mock.calls[0]?.[0]).toMatch(/something_else, endpoints/);
  });

  it('falls back to console.warn when logger is omitted on unrecognized shape', () => {
    // CJS parity: unrecognized-shape warning must be loud by default.
    // Surfaces can override `opts.logger`; opting out of warnings is an
    // explicit `() => {}` choice, not the easy-to-forget default.
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const out = extractRunningEndpoints({ something_else: 'x' });
      expect(out).toEqual([]);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/unrecognized shape/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('explicit no-op logger suppresses the default console.warn', () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const noopLogger: (reason: string) => void = () => undefined;
      extractRunningEndpoints({ something_else: 'x' }, { logger: noopLogger });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when services-map exists even if empty', () => {
    const logger = vi.fn();
    extractRunningEndpoints({ services: {} }, { logger });
    expect(logger).not.toHaveBeenCalled();
  });
});

describe('formatEndpointAsIngress', () => {
  it('returns the bare fqdn', () => {
    expect(formatEndpointAsIngress({ fqdn: 'app.example.com' })).toBe(
      'app.example.com',
    );
  });
});

describe('formatEndpointAsUrl', () => {
  it('returns https URL with trailing slash', () => {
    expect(formatEndpointAsUrl({ fqdn: 'app.example.com' })).toBe(
      'https://app.example.com/',
    );
  });
});

describe('hasRunningInstances', () => {
  it('returns false for null / non-object', () => {
    expect(hasRunningInstances(null)).toBe(false);
    expect(hasRunningInstances(undefined)).toBe(false);
    expect(hasRunningInstances('x')).toBe(false);
  });

  it('returns true when top-level instances has at least one running (no fqdn needed)', () => {
    expect(
      hasRunningInstances({ instances: [{ status: 'running' /* no fqdn */ }] }),
    ).toBe(true);
  });

  it('returns true when a service has at least one running instance', () => {
    expect(
      hasRunningInstances({
        services: {
          internal: { instances: [{ status: 'running' /* no fqdn */ }] },
        },
      }),
    ).toBe(true);
  });

  it('returns false when no instance is running', () => {
    expect(hasRunningInstances({ instances: [{ status: 'pending' }] })).toBe(
      false,
    );
    expect(
      hasRunningInstances({
        services: { web: { instances: [{ status: 'failed' }] } },
      }),
    ).toBe(false);
  });

  it('returns false for empty / missing instance arrays', () => {
    expect(hasRunningInstances({ instances: [] })).toBe(false);
    expect(hasRunningInstances({ services: {} })).toBe(false);
    expect(hasRunningInstances({})).toBe(false);
  });
});
