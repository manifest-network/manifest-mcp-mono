import { describe, expect, it } from 'vitest';
import {
  FredActionResponseSchema,
  FredLeaseLogsResponseSchema,
  FredLeaseProvisionResponseSchema,
  FredLeaseReleasesResponseSchema,
  hadValidationDrops,
  LeaseConnectionResponseSchema,
  ProviderHealthResponseSchema,
  RawLeaseStatusResponseSchema,
} from './response-schemas.js';

const identity = {
  lease_uuid: '550e8400-e29b-41d4-a716-446655440000',
  tenant: 'manifest1tenant',
  provider_uuid: 'provider-1',
};

describe('provider response schemas', () => {
  it.each([
    ['status', RawLeaseStatusResponseSchema, { state: 'LEASE_STATE_ACTIVE' }],
    ['logs', FredLeaseLogsResponseSchema, { ...identity, logs: null }],
    [
      'provision',
      FredLeaseProvisionResponseSchema,
      { status: 'ready', fail_count: 0 },
    ],
    ['action', FredActionResponseSchema, { status: 'ok' }],
    [
      'releases',
      FredLeaseReleasesResponseSchema,
      { ...identity, releases: null },
    ],
    [
      'health',
      ProviderHealthResponseSchema,
      { status: 'healthy', provider_uuid: 'provider-1', checks: null },
    ],
    [
      'connection',
      LeaseConnectionResponseSchema,
      { ...identity, connection: { host: 'provider.example.com' } },
    ],
  ])(
    'accepts the %s endpoint Go zero-value response',
    (_name, schema, value) => {
      expect(schema.safeParse(value).success).toBe(true);
    },
  );

  it('normalizes nil Go slices and maps without treating them as data loss', () => {
    const releases = FredLeaseReleasesResponseSchema.parse({
      ...identity,
      releases: null,
    });
    const status = RawLeaseStatusResponseSchema.parse({
      state: 'LEASE_STATE_ACTIVE',
      services: { web: { instances: null } },
    });
    const connection = LeaseConnectionResponseSchema.parse({
      ...identity,
      connection: {
        host: 'provider.example.com',
        services: { web: { instances: null } },
      },
    });
    const health = ProviderHealthResponseSchema.parse({
      status: 'healthy',
      provider_uuid: 'provider-1',
      checks: null,
    });

    expect(releases.releases).toEqual([]);
    expect(status.services?.web?.instances).toEqual([]);
    expect(connection.connection.services?.web?.instances).toEqual([]);
    expect(health.checks).toEqual({});
    expect(hadValidationDrops(status)).toBe(false);
  });

  it('parses Fred PortMapping objects consistently on status and connection paths', () => {
    const port = { host_ip: '127.0.0.1', host_port: 32_768 };
    const status = RawLeaseStatusResponseSchema.parse({
      state: 'LEASE_STATE_ACTIVE',
      instances: [
        { name: 'web-0', status: 'running', ports: { '80/tcp': port } },
      ],
    });
    const connection = LeaseConnectionResponseSchema.parse({
      ...identity,
      connection: {
        host: 'provider.example.com',
        instances: [{ instance_index: 0, ports: { '80/tcp': port } }],
      },
    });

    expect(status.instances?.[0]?.ports?.['80/tcp']).toEqual(port);
    expect(connection.connection.instances?.[0]?.ports?.['80/tcp']).toEqual(
      port,
    );
  });

  it('drops malformed collection entries while preserving valid siblings', () => {
    const status = RawLeaseStatusResponseSchema.parse({
      state: 'LEASE_STATE_CLOSED',
      endpoints: { web: 'https://web.example.com', broken: 42 },
      items: [
        { sku: 'small', quantity: 1 },
        { sku: 42, quantity: 1 },
        { sku: 'database', quantity: 'wrong' },
      ],
      services: {
        web: { instances: null },
        broken: { instances: 'wrong' },
      },
    });
    const health = ProviderHealthResponseSchema.parse({
      status: 'degraded',
      provider_uuid: 'provider-1',
      checks: {
        chain: { status: 'failed', message: 'timeout' },
        broken: { status: 42 },
      },
    });

    expect(status.endpoints).toEqual({ web: 'https://web.example.com' });
    expect(status.items?.map((item) => item.sku)).toEqual([
      'small',
      'database',
    ]);
    expect(status.services).toEqual({ web: { instances: [] } });
    expect(health.checks).toEqual({
      chain: { status: 'failed', message: 'timeout' },
    });
    expect(hadValidationDrops(status)).toBe(true);
    expect(hadValidationDrops(health)).toBe(true);
  });

  it('tracks log entries rejected by the tolerant map without changing its JSON shape', () => {
    const parsed = FredLeaseLogsResponseSchema.parse({
      ...identity,
      logs: { web: 'ready', broken: 42 },
    });

    expect(parsed.logs).toEqual({ web: 'ready' });
    expect(hadValidationDrops(parsed.logs)).toBe(true);
    expect(Object.getOwnPropertySymbols(parsed.logs)).toEqual([]);
  });

  it.each([
    ['status', RawLeaseStatusResponseSchema, null],
    ['health', ProviderHealthResponseSchema, { status: 'healthy', checks: {} }],
    [
      'connection',
      LeaseConnectionResponseSchema,
      { ...identity, connection: {} },
    ],
    [
      'releases',
      FredLeaseReleasesResponseSchema,
      { ...identity, releases: 'wrong' },
    ],
  ])('rejects an invalid required %s shape', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
