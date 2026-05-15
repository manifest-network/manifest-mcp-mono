import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DeployResponse,
  type FormatSuccessInput,
  formatSuccess,
} from './format-success.js';

const FIXTURES_ROOT = join(__dirname, '..', '..', '__fixtures__');

function readFixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES_ROOT, ...parts), 'utf8');
}

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

function baseInput(
  overrides: Partial<DeployResponse> = {},
): FormatSuccessInput {
  return {
    leaseUuid: VALID_UUID,
    deployResponse: {
      state: 'LEASE_STATE_ACTIVE',
      provider_uuid: '22222222-2222-4222-8222-222222222222',
      connection: {
        instances: [{ status: 'running', fqdn: 'app.testnet.manifest.app' }],
      },
      ...overrides,
    },
  };
}

describe('formatSuccess', () => {
  describe('input validation', () => {
    it('throws TypeError for non-UUID lease', () => {
      expect(() =>
        formatSuccess({
          leaseUuid: 'not-a-uuid',
          deployResponse: { state: 'LEASE_STATE_ACTIVE' },
        }),
      ).toThrow(/leaseUuid must be a UUID/);
    });

    it('throws TypeError for null deployResponse', () => {
      expect(() =>
        formatSuccess({
          leaseUuid: VALID_UUID,
          deployResponse: null as unknown as DeployResponse,
        }),
      ).toThrow(/deployResponse must be a non-null object/);
    });
  });

  describe('basic rendering', () => {
    it('renders the standard 4-line header', () => {
      const out = formatSuccess(baseInput());
      expect(out).toContain('Deployed.');
      expect(out).toContain(
        '  Provider:      22222222-2222-4222-8222-222222222222',
      );
      expect(out).toContain(`  Lease UUID:    ${VALID_UUID}`);
      expect(out).toContain('  Lease Status:  ACTIVE');
    });

    it('appends the troubleshoot hint with the lease UUID', () => {
      const out = formatSuccess(baseInput());
      expect(out).toContain(
        `For logs / status:  /manifest-agent:troubleshoot-deployment ${VALID_UUID}`,
      );
    });

    it('renders "(unknown)" provider when provider_uuid is missing', () => {
      const out = formatSuccess(baseInput({ provider_uuid: undefined }));
      expect(out).toContain('  Provider:      (unknown)');
    });
  });

  describe('lease-state decoding', () => {
    it('strips LEASE_STATE_ prefix for known string states', () => {
      const out = formatSuccess(baseInput({ state: 'LEASE_STATE_PENDING' }));
      expect(out).toContain('  Lease Status:  PENDING');
    });

    it('decodes integer state via lease-state.decode', () => {
      // 2 → LEASE_STATE_ACTIVE per the canonical STATES table.
      const out = formatSuccess(baseInput({ state: 2 }));
      expect(out).toContain('  Lease Status:  ACTIVE');
    });

    it('renders "(unknown)" for absent state', () => {
      const out = formatSuccess(baseInput({ state: undefined }));
      expect(out).toContain('  Lease Status:  (unknown)');
    });

    it('renders UNKNOWN(<raw>) for unrecognized values', () => {
      const out = formatSuccess(baseInput({ state: 999 }));
      expect(out).toContain('  Lease Status:  UNKNOWN(999)');
    });
  });

  describe('ingress rendering', () => {
    it('renders single Ingress line for one FQDN', () => {
      const out = formatSuccess(baseInput());
      expect(out).toContain('  Ingress:       app.testnet.manifest.app');
      expect(out).not.toContain('  Ingresses:');
    });

    it('renders Ingresses: list for multiple unique FQDNs', () => {
      const out = formatSuccess(
        baseInput({
          connection: {
            services: {
              web: {
                instances: [{ status: 'running', fqdn: 'web.example.com' }],
              },
              api: {
                instances: [{ status: 'running', fqdn: 'api.example.com' }],
              },
            },
          },
        }),
      );
      expect(out).toContain('  Ingresses:');
      expect(out).toContain('    - web.example.com');
      expect(out).toContain('    - api.example.com');
    });

    it('renders "(none — service is internal or no FQDN reported)" when no running instances', () => {
      const out = formatSuccess(
        baseInput({
          connection: {
            instances: [{ status: 'pending', fqdn: 'app.example.com' }],
          },
        }),
      );
      expect(out).toContain(
        '  Ingress:       (none — service is internal or no FQDN reported)',
      );
    });

    it('dedupes shared FQDNs across replica instances', () => {
      const out = formatSuccess(
        baseInput({
          connection: {
            instances: [
              { status: 'running', fqdn: 'app.example.com' },
              { status: 'running', fqdn: 'app.example.com' },
            ],
          },
        }),
      );
      // Single FQDN → single Ingress line, not Ingresses block.
      expect(out).toContain('  Ingress:       app.example.com');
      expect(out).not.toContain('  Ingresses:');
    });

    // Copilot review fix (PR #58 r3248900271): legacy top-level `url`
    // fallback. When `connection.instances` is empty/missing but fred
    // still surfaces `url` at the top level (older provider shape),
    // render it as the Ingress line — mirrors the classifier's
    // defensive fallback at `classify-deploy-response.ts:76-80`.
    it('renders top-level `url` as Ingress when connection has no running instances', () => {
      const out = formatSuccess(
        baseInput({
          connection: undefined,
          url: 'https://app.example.com/',
        }),
      );
      expect(out).toContain('  Ingress:       https://app.example.com/');
      // `(none …)` fallback must NOT fire when `url` is present.
      expect(out).not.toContain('(none — service is internal');
    });

    it('prefixes scheme-less `url` with `https://` and trailing slash, matching the classifier', () => {
      const out = formatSuccess(
        baseInput({
          connection: undefined,
          url: 'app.example.com',
        }),
      );
      expect(out).toContain('  Ingress:       https://app.example.com/');
    });

    it('still renders `(none …)` when both `connection.instances` and `url` are empty', () => {
      const out = formatSuccess(
        baseInput({
          connection: { instances: [] },
          url: undefined,
        }),
      );
      expect(out).toContain(
        '  Ingress:       (none — service is internal or no FQDN reported)',
      );
    });

    it('prefers `connection.instances` FQDN over top-level `url` when both are present', () => {
      const out = formatSuccess(
        baseInput({
          connection: {
            instances: [{ status: 'running', fqdn: 'preferred.example.com' }],
          },
          url: 'https://fallback.example.com/',
        }),
      );
      expect(out).toContain('  Ingress:       preferred.example.com');
      expect(out).not.toContain('fallback.example.com');
    });
  });

  describe('custom-domain block', () => {
    it('omits the custom-domain block when not set', () => {
      const out = formatSuccess(baseInput({ custom_domain: undefined }));
      expect(out).not.toContain('Custom domain (provisioning)');
    });

    it('emits the custom-domain block BEFORE the Ingress line', () => {
      const out = formatSuccess(
        baseInput({ custom_domain: 'app.example.com' }),
      );
      const customIdx = out.indexOf('Custom domain (provisioning):');
      const ingressIdx = out.indexOf('Ingress:       ');
      expect(customIdx).toBeGreaterThan(0);
      expect(ingressIdx).toBeGreaterThan(customIdx);
      expect(out).toContain(
        '  Custom domain (provisioning):  https://app.example.com/',
      );
      expect(out).toContain(
        '    — TLS may take a few minutes; the Ingress URL below works immediately.',
      );
    });

    // Copilot review fix (PR #58 r3250192778): the TLS note's
    // "Ingress URL below works immediately" promise must not fire
    // when the Ingress section will render `(none …)`. Otherwise the
    // user is told to look for a URL that doesn't exist.
    it('renders shortened TLS note when no Ingress available (no instances, no url)', () => {
      const out = formatSuccess(
        baseInput({
          custom_domain: 'x.example.com',
          connection: { instances: [] },
          url: undefined,
        }),
      );
      // Custom-domain block still emits.
      expect(out).toContain(
        '  Custom domain (provisioning):  https://x.example.com/',
      );
      // Shortened TLS note — no false "Ingress URL below" promise.
      expect(out).toContain('    — TLS may take a few minutes.');
      expect(out).not.toContain('the Ingress URL below works immediately');
      // And the Ingress section actually IS the `(none …)` fallback.
      expect(out).toContain(
        '  Ingress:       (none — service is internal or no FQDN reported)',
      );
    });

    it('keeps full TLS note when running instances provide Ingress', () => {
      const out = formatSuccess(
        baseInput({
          custom_domain: 'x.example.com',
          connection: {
            instances: [{ status: 'running', fqdn: 'app.example.com' }],
          },
        }),
      );
      expect(out).toContain(
        '    — TLS may take a few minutes; the Ingress URL below works immediately.',
      );
    });

    it('keeps full TLS note when top-level `url` provides Ingress fallback', () => {
      const out = formatSuccess(
        baseInput({
          custom_domain: 'x.example.com',
          connection: undefined,
          url: 'app.example.com',
        }),
      );
      expect(out).toContain(
        '    — TLS may take a few minutes; the Ingress URL below works immediately.',
      );
    });
  });

  describe('byte-baseline parity', () => {
    it('matches expected output for 01-fast-path-active fixture', () => {
      const deployResponse = JSON.parse(
        readFixture(
          'skills',
          'deploy-app',
          '01-fast-path-active',
          'input',
          'deploy-response.json',
        ),
      ) as DeployResponse;
      const expected = readFixture(
        'skills',
        'deploy-app',
        '01-fast-path-active',
        'expected-success.txt',
      );
      const actual = formatSuccess({
        leaseUuid: VALID_UUID,
        deployResponse,
      });
      // Fixture has trailing newline from CJS console.log; strip for compare.
      expect(actual).toBe(expected.replace(/\n$/, ''));
    });
  });
});
