import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { FRED_MANIFEST_LIMITS } from './generated/fred-manifest-limits.js';
import generatedSchemaValidate from './generated/fred-manifest-schema-validator.js';
import { validateManifest } from './manifest.js';

const schemaPath = fileURLToPath(
  new URL('../schema/manifest-schema.json', import.meta.url),
);
const fredManifestSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

function schemaCompiler() {
  return new Ajv2020({
    allErrors: true,
    strict: true,
    // These are the two deliberate constructs in Fred's current schema. Keep
    // every other strict diagnostic (especially unknown keywords) fatal.
    strictTypes: false,
    strictTuples: false,
  });
}

const sourceSchemaValidate = schemaCompiler().compile(fredManifestSchema);

interface ContractCase {
  readonly name: string;
  readonly manifest: unknown;
  readonly schemaValid: boolean;
  readonly preflightValid?: boolean;
}

const contractCases: readonly ContractCase[] = [
  {
    name: 'minimal single-service manifest',
    manifest: { image: 'nginx' },
    schemaValid: true,
  },
  {
    name: 'minimal stack manifest',
    manifest: { services: { web: { image: 'nginx' } } },
    schemaValid: true,
  },
  {
    name: 'missing image',
    manifest: { ports: { '80/tcp': {} } },
    schemaValid: false,
  },
  {
    name: 'unknown service field',
    manifest: { image: 'nginx', volumes: ['/data'] },
    schemaValid: false,
  },
  {
    name: 'command must be an array',
    manifest: { image: 'nginx', command: 'sh -c echo' },
    schemaValid: false,
  },
  {
    name: 'command entries must be strings',
    manifest: { image: 'nginx', command: [1, 2] },
    schemaValid: false,
  },
  {
    name: 'args must be an array',
    manifest: { image: 'nginx', args: '--verbose' },
    schemaValid: false,
  },
  {
    name: 'label values must be strings',
    manifest: { image: 'nginx', labels: { app: 1 } },
    schemaValid: false,
  },
  {
    name: 'dynamic host port',
    manifest: { image: 'nginx', ports: { '80/tcp': { host_port: 0 } } },
    schemaValid: true,
  },
  {
    name: 'fixed host port',
    manifest: {
      image: 'nginx',
      ports: { '80/tcp': { host_port: 8080 } },
    },
    schemaValid: false,
  },
  {
    name: 'unknown port configuration field',
    manifest: { image: 'nginx', ports: { '80/tcp': { published: 8080 } } },
    schemaValid: false,
  },
  {
    name: 'invalid port specification',
    manifest: { image: 'nginx', ports: { '70000/tcp': {} } },
    schemaValid: false,
  },
  {
    name: 'exact reserved PATH environment variable',
    manifest: { image: 'nginx', env: { PATH: '/bin' } },
    schemaValid: false,
  },
  {
    name: 'PATH prefix near misses',
    manifest: {
      image: 'nginx',
      env: { PATHS: '/srv', PATH_PREFIX: '/opt' },
    },
    schemaValid: true,
  },
  {
    name: 'lowercase reserved traefik label',
    manifest: {
      image: 'nginx',
      labels: { 'traefik.http.routers.web.rule': 'Host(`app.example`)' },
    },
    schemaValid: false,
  },
  {
    name: 'blocked tmpfs mount',
    manifest: { image: 'nginx', tmpfs: ['/proc/meminfo'] },
    schemaValid: false,
  },
  {
    name: 'valid bare expose port',
    manifest: { image: 'nginx', expose: ['8080'] },
    schemaValid: true,
  },
  {
    name: 'compose-style expose port',
    manifest: { image: 'nginx', expose: ['8080/tcp'] },
    schemaValid: false,
  },
  {
    name: 'invalid health-check interval',
    manifest: {
      image: 'nginx',
      health_check: { test: ['NONE'], interval: 'abc' },
    },
    schemaValid: false,
  },
  {
    name: 'out-of-range simple stop grace period',
    manifest: { image: 'nginx', stop_grace_period: '500s' },
    schemaValid: false,
  },
  {
    name: 'sub-second stop grace Go-bound overlay',
    manifest: { image: 'nginx', stop_grace_period: '0.5s' },
    schemaValid: true,
    preflightValid: false,
  },
  {
    name: 'non-empty single-service depends_on',
    manifest: {
      image: 'nginx',
      depends_on: { db: { condition: 'service_started' } },
    },
    schemaValid: false,
  },
  {
    name: 'invalid stack service name',
    manifest: { services: { Web: { image: 'nginx' } } },
    schemaValid: false,
  },
  // Named Go semantic overlays below. These are intentionally stricter than
  // the published JSON schema and must remain visible as different verdicts.
  {
    name: 'mixed-case reserved Fred label overlay',
    manifest: { image: 'nginx', labels: { 'Fred.owner': 'blocked' } },
    schemaValid: true,
    preflightValid: false,
  },
  {
    name: 'mixed-case reserved Traefik label overlay',
    manifest: { image: 'nginx', labels: { 'TRAEFIK.enable': 'blocked' } },
    schemaValid: true,
    preflightValid: false,
  },
  {
    name: 'UDP ingress overlay',
    manifest: { image: 'nginx', ports: { '53/udp': { ingress: true } } },
    schemaValid: true,
    preflightValid: false,
  },
  {
    name: 'multiple ingress ports overlay',
    manifest: {
      image: 'nginx',
      ports: {
        '80/tcp': { ingress: true },
        '443/tcp': { ingress: true },
      },
    },
    schemaValid: true,
    preflightValid: false,
  },
  {
    name: 'normalized sensitive tmpfs overlay',
    manifest: { image: 'nginx', tmpfs: ['/var/../proc'] },
    schemaValid: true,
    preflightValid: false,
  },
  {
    name: 'normalized duplicate tmpfs overlay',
    manifest: { image: 'nginx', tmpfs: ['/a', '/a/'] },
    schemaValid: true,
    preflightValid: false,
  },
  {
    name: 'fractional stop grace runtime-bound overlay',
    manifest: { image: 'nginx', stop_grace_period: '500.0s' },
    schemaValid: true,
    preflightValid: false,
  },
  // Fred's published schema is narrower than its encoding/json decoder and
  // Go semantic validators. These rows protect provider-accepted payloads
  // from becoming false rejects in deploy/update pre-flight.
  {
    name: 'nanosecond stop grace accepted by Go',
    manifest: { image: 'nginx', stop_grace_period: '1000000000ns' },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'maximum nanosecond stop grace accepted by Go',
    manifest: { image: 'nginx', stop_grace_period: '120000000000ns' },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'microsecond stop grace accepted by Go',
    manifest: { image: 'nginx', stop_grace_period: '1000000us' },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'leading-zero stop grace accepted by Go',
    manifest: { image: 'nginx', stop_grace_period: '0120s' },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'explicit-plus stop grace accepted by Go',
    manifest: { image: 'nginx', stop_grace_period: '+5s' },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'empty-fraction stop grace accepted by Go',
    manifest: { image: 'nginx', stop_grace_period: '1.s' },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'empty user accepted by Go',
    manifest: { image: 'nginx', user: '' },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'multi-colon user accepted by Go SplitN',
    manifest: { image: 'nginx', user: 'a:b:c' },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'null label value decoded as empty string by Go',
    manifest: { image: 'nginx', labels: { app: null } },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'zero health duration accepted by Go',
    manifest: {
      image: 'nginx',
      health_check: { test: ['NONE'], interval: '0' },
    },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'negative health duration accepted by Go',
    manifest: {
      image: 'nginx',
      health_check: { test: ['NONE'], timeout: '-5s' },
    },
    schemaValid: false,
    preflightValid: true,
  },
  {
    name: 'Greek-mu health duration accepted by Go',
    manifest: {
      image: 'nginx',
      health_check: { test: ['NONE'], start_period: '5μs' },
    },
    schemaValid: false,
    preflightValid: true,
  },
];

describe('Fred manifest schema contract', () => {
  it.each(contractCases)(
    'keeps the generated and semantic validators aligned for $name',
    ({ manifest, schemaValid, preflightValid = schemaValid }) => {
      expect(
        sourceSchemaValidate(manifest),
        JSON.stringify(sourceSchemaValidate.errors),
      ).toBe(schemaValid);
      expect(
        generatedSchemaValidate(manifest),
        JSON.stringify(sourceSchemaValidate.errors),
      ).toBe(schemaValid);
      expect(validateManifest(manifest).valid).toBe(preflightValid);
    },
  );

  it('keeps unknown schema keywords fatal while compiling the sync contract', () => {
    expect(() =>
      schemaCompiler().compile({
        ...fredManifestSchema,
        maxProperies: 64,
      }),
    ).toThrow(/unknown keyword/i);
  });

  const capCases = [
    {
      field: 'ports',
      cap: FRED_MANIFEST_LIMITS.maxPorts,
      manifest: (count: number) => ({
        image: 'nginx',
        ports: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`${index + 1}/tcp`, {}]),
        ),
      }),
    },
    {
      field: 'expose',
      cap: FRED_MANIFEST_LIMITS.maxExposePorts,
      manifest: (count: number) => ({
        image: 'nginx',
        expose: Array.from({ length: count }, (_, index) => `${index + 1}`),
      }),
    },
    {
      field: 'env',
      cap: FRED_MANIFEST_LIMITS.maxEnvVars,
      manifest: (count: number) => ({
        image: 'nginx',
        env: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`APP_${index}`, 'x']),
        ),
      }),
    },
    {
      field: 'labels',
      cap: FRED_MANIFEST_LIMITS.maxLabels,
      manifest: (count: number) => ({
        image: 'nginx',
        labels: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`app.${index}`, 'x']),
        ),
      }),
    },
  ] as const;

  it.each(capCases)(
    'derives the schema-omitted $field cap from pinned Fred Go source',
    ({ cap, manifest }) => {
      const atLimit = manifest(cap);
      const overLimit = manifest(cap + 1);

      expect(sourceSchemaValidate(atLimit)).toBe(true);
      expect(generatedSchemaValidate(atLimit)).toBe(true);
      expect(validateManifest(atLimit).valid).toBe(true);
      expect(sourceSchemaValidate(overLimit)).toBe(true);
      expect(generatedSchemaValidate(overLimit)).toBe(true);
      expect(validateManifest(overLimit).valid).toBe(false);
    },
  );

  it('keeps the schema tmpfs cap aligned with the generated Go limit', () => {
    const manifest = (count: number) => ({
      image: 'nginx',
      tmpfs: Array.from(
        { length: count },
        (_, index) => `/var/cache/app-${index}`,
      ),
    });
    const atLimit = manifest(FRED_MANIFEST_LIMITS.maxTmpfsMounts);
    const overLimit = manifest(FRED_MANIFEST_LIMITS.maxTmpfsMounts + 1);

    expect(sourceSchemaValidate(atLimit)).toBe(true);
    expect(generatedSchemaValidate(atLimit)).toBe(true);
    expect(validateManifest(atLimit).valid).toBe(true);
    expect(sourceSchemaValidate(overLimit)).toBe(false);
    expect(generatedSchemaValidate(overLimit)).toBe(false);
    expect(validateManifest(overLimit).valid).toBe(false);
  });
});
