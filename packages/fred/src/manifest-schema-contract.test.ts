import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { validateManifest } from './manifest.js';

const schemaPath = fileURLToPath(
  new URL('../schema/manifest-schema.json', import.meta.url),
);
const fredManifestSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

// Fred's schema currently has two strict-mode diagnostics (tuple annotations
// and a `not.required` subschema without an explicit object type). They are
// valid draft-2020-12 constructs, so compile the source verbatim rather than
// weakening or locally patching the vendored contract.
const schemaValidate = new Ajv2020({
  allErrors: true,
  strict: false,
}).compile(fredManifestSchema);

interface ContractCase {
  readonly name: string;
  readonly manifest: unknown;
  readonly valid: boolean;
}

const contractCases: readonly ContractCase[] = [
  {
    name: 'minimal single-service manifest',
    manifest: { image: 'nginx' },
    valid: true,
  },
  {
    name: 'minimal stack manifest',
    manifest: { services: { web: { image: 'nginx' } } },
    valid: true,
  },
  {
    name: 'missing image',
    manifest: { ports: { '80/tcp': {} } },
    valid: false,
  },
  {
    name: 'unknown service field',
    manifest: { image: 'nginx', volumes: ['/data'] },
    valid: false,
  },
  {
    name: 'dynamic host port',
    manifest: { image: 'nginx', ports: { '80/tcp': { host_port: 0 } } },
    valid: true,
  },
  {
    name: 'fixed host port',
    manifest: {
      image: 'nginx',
      ports: { '80/tcp': { host_port: 8080 } },
    },
    valid: false,
  },
  {
    name: 'unknown port configuration field',
    manifest: { image: 'nginx', ports: { '80/tcp': { published: 8080 } } },
    valid: false,
  },
  {
    name: 'invalid port specification',
    manifest: { image: 'nginx', ports: { '70000/tcp': {} } },
    valid: false,
  },
  {
    name: 'exact reserved PATH environment variable',
    manifest: { image: 'nginx', env: { PATH: '/bin' } },
    valid: false,
  },
  {
    name: 'PATH prefix near misses',
    manifest: {
      image: 'nginx',
      env: { PATHS: '/srv', PATH_PREFIX: '/opt' },
    },
    valid: true,
  },
  {
    name: 'lowercase reserved traefik label',
    manifest: {
      image: 'nginx',
      labels: { 'traefik.http.routers.web.rule': 'Host(`app.example`)' },
    },
    valid: false,
  },
  {
    name: 'blocked tmpfs mount',
    manifest: { image: 'nginx', tmpfs: ['/proc/meminfo'] },
    valid: false,
  },
  {
    name: 'valid bare expose port',
    manifest: { image: 'nginx', expose: ['8080'] },
    valid: true,
  },
  {
    name: 'compose-style expose port',
    manifest: { image: 'nginx', expose: ['8080/tcp'] },
    valid: false,
  },
  {
    name: 'non-empty single-service depends_on',
    manifest: {
      image: 'nginx',
      depends_on: { db: { condition: 'service_started' } },
    },
    valid: false,
  },
  {
    name: 'invalid stack service name',
    manifest: { services: { Web: { image: 'nginx' } } },
    valid: false,
  },
];

describe('Fred manifest schema contract', () => {
  it.each(contractCases)(
    'keeps validateManifest aligned for $name',
    ({ manifest, valid }) => {
      expect(
        schemaValidate(manifest),
        JSON.stringify(schemaValidate.errors),
      ).toBe(valid);
      expect(validateManifest(manifest).valid).toBe(valid);
    },
  );

  it.each(['Fred.owner', 'TRAEFIK.enable'])(
    'records the Go semantic overlay for mixed-case reserved label %s',
    (key) => {
      const manifest = { image: 'nginx', labels: { [key]: 'blocked' } };

      // v0.13.0's JSON Schema pattern is lowercase-only, while Fred's Go
      // admission validator uses EqualFold (ENG-595). Keep the stricter server
      // contract explicit; this expectation also prompts cleanup when Fred's
      // published schema gains the missing case-insensitive expression.
      expect(schemaValidate(manifest)).toBe(true);
      expect(validateManifest(manifest).valid).toBe(false);
    },
  );

  it.each([
    [
      'ports',
      {
        image: 'nginx',
        ports: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`${index + 1}/tcp`, {}]),
        ),
      },
    ],
    [
      'expose',
      {
        image: 'nginx',
        expose: Array.from({ length: 65 }, (_, index) => `${index + 1}`),
      },
    ],
    [
      'env',
      {
        image: 'nginx',
        env: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`APP_${index}`, 'x']),
        ),
      },
    ],
    [
      'labels',
      {
        image: 'nginx',
        labels: Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [`app.${index}`, 'x']),
        ),
      },
    ],
  ])("records Fred v0.13.0's schema-omitted %s cap", (_field, manifest) => {
    // ENG-547's Go admission caps are absent from the published schema. Treat
    // them as an explicit semantic overlay until the source schema carries
    // maxProperties/maxItems itself.
    expect(schemaValidate(manifest)).toBe(true);
    expect(validateManifest(manifest).valid).toBe(false);
  });
});
