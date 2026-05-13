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
        instances: [
          { status: 'running', fqdn: 'app.testnet.manifest.app' },
        ],
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
      const out = formatSuccess(
        baseInput({ provider_uuid: undefined }),
      );
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
                instances: [
                  { status: 'running', fqdn: 'web.example.com' },
                ],
              },
              api: {
                instances: [
                  { status: 'running', fqdn: 'api.example.com' },
                ],
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
