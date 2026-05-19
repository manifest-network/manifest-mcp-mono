import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeploySpec, SingleServiceSpec, StackSpec } from '../types.js';
import { renderIntentRecap } from './render-intent-recap.js';

const FIXTURES_ROOT = join(__dirname, '..', '..', '__fixtures__');

function readFixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES_ROOT, ...parts), 'utf8');
}

describe('renderIntentRecap', () => {
  describe('basic single-service rendering', () => {
    it('renders count + service line for single-service spec', () => {
      const spec: SingleServiceSpec = {
        image: 'nginx:1.27',
        port: 80,
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain('Deploying 1 service on testnet:');
      expect(out).toContain('  - nginx:1.27');
    });

    it('uses singular "service" noun when count = 1', () => {
      const spec: SingleServiceSpec = { image: 'nginx:1.27' };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toMatch(/Deploying 1 service /);
    });

    it('uses plural "services" noun when count > 1', () => {
      const spec: StackSpec = {
        services: {
          web: { image: 'nginx:1.27' },
          db: { image: 'postgres:16' },
        },
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toMatch(/Deploying 2 services /);
    });

    it('prefixes stack-service entries with their name', () => {
      const spec: StackSpec = {
        services: {
          web: { image: 'nginx:1.27' },
          db: { image: 'postgres:16' },
        },
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain('  - web — nginx:1.27');
      expect(out).toContain('  - db — postgres:16');
    });

    it('renders "(unknown image)" placeholder when image is missing', () => {
      const spec = { image: '' } as unknown as SingleServiceSpec;
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain('  - (unknown image)');
    });
  });

  describe('connectivity block', () => {
    it('renders legacy single-service port as ingress=true', () => {
      const spec: SingleServiceSpec = { image: 'nginx:1.27', port: 80 };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        "  - port 80: publicly reachable via the provider's HTTPS subdomain",
      );
    });

    it('renders no-ports placeholder when no ports declared', () => {
      const spec: SingleServiceSpec = { image: 'nginx:1.27' };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        '  (no ports declared — the deployment will not expose any network surface)',
      );
    });

    it('renders services-map Record ports with declared ingress flag', () => {
      const spec = {
        services: {
          web: {
            image: 'nginx:1.27',
            ports: {
              '80': { ingress: true },
              '9090': { ingress: false },
            },
          },
        },
      } as unknown as DeploySpec;
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        "  - web port 80: publicly reachable via the provider's HTTPS subdomain",
      );
      expect(out).toContain(
        '  - web port 9090: internal only (cluster-private)',
      );
    });

    it('defaults ingress=false when services-map config omits the flag', () => {
      const spec = {
        services: {
          web: { image: 'nginx:1.27', ports: { '80': {} } },
        },
      } as unknown as DeploySpec;
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain('  - web port 80: internal only (cluster-private)');
    });

    it('renders single-service `port` array as ingress=true entries', () => {
      const spec = {
        image: 'app:latest',
        port: [80, 443],
      } as unknown as SingleServiceSpec;
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        "  - port 80: publicly reachable via the provider's HTTPS subdomain",
      );
      expect(out).toContain(
        "  - port 443: publicly reachable via the provider's HTTPS subdomain",
      );
    });

    it('renders typed `ports: number[]` on ServiceDef as ingress=false (services-map default)', () => {
      const spec: StackSpec = {
        services: {
          web: { image: 'nginx:1.27', ports: [80] },
        },
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain('  - web port 80: internal only (cluster-private)');
    });
  });

  describe('redacted inventory block', () => {
    it('renders env keys sorted; never the values', () => {
      const spec: SingleServiceSpec = {
        image: 'app:1',
        env: { NGINX_PORT: '80', NGINX_HOST: 'example.com' },
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        '  - this service: env keys [NGINX_HOST, NGINX_PORT]',
      );
      expect(out).not.toContain('80');
      expect(out).not.toContain('example.com');
    });

    it('renders label keys sorted; never the values', () => {
      const spec = {
        image: 'app:1',
        labels: { 'app/role': 'web', 'app/owner': 'team' },
      } as unknown as SingleServiceSpec;
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        '  - this service: label keys [app/owner, app/role]',
      );
      expect(out).not.toContain(': web');
      expect(out).not.toContain('team');
    });

    it('combines env + label keys with semicolon separator', () => {
      const spec = {
        image: 'app:1',
        env: { FOO: 'bar' },
        labels: { 'a/b': 'c' },
      } as unknown as SingleServiceSpec;
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        '  - this service: env keys [FOO]; label keys [a/b]',
      );
    });

    it('renders "no env or labels supplied" when service has neither', () => {
      const spec: SingleServiceSpec = { image: 'app:1' };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain('  - this service: no env or labels supplied');
    });

    it('renders empty-fallback line when no service across the spec has env/labels', () => {
      const spec: SingleServiceSpec = { image: 'app:1' };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        '  - (no env or labels supplied across any service — nothing to redact)',
      );
    });
  });

  describe('custom-domain block', () => {
    it('omits the block when no customDomain is set', () => {
      const spec: SingleServiceSpec = { image: 'app:1' };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).not.toContain('Custom domain:');
    });

    it('renders "single-service lease" target for SingleServiceSpec + customDomain', () => {
      const spec: SingleServiceSpec = {
        image: 'app:1',
        customDomain: 'app.testnet.manifest.app',
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        'Custom domain: app.testnet.manifest.app → single-service lease',
      );
    });

    it('renders "service <name>" target for StackSpec + customDomain + serviceName', () => {
      const spec: StackSpec = {
        services: { web: { image: 'nginx:1.27' } },
        customDomain: 'web.example.com',
        serviceName: 'web',
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain('Custom domain: web.example.com → service web');
    });

    it('appends the dual-tx clarifier paragraph', () => {
      const spec: SingleServiceSpec = {
        image: 'app:1',
        customDomain: 'app.testnet.manifest.app',
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).toContain(
        'deploy_app broadcasts TWO billing\ntransactions atomically',
      );
    });

    it('omits mainnet warning on testnet', () => {
      const spec: SingleServiceSpec = {
        image: 'app:1',
        customDomain: 'app.example.com',
      };
      const out = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(out).not.toContain('Mainnet warning');
    });

    it('appends mainnet warning on mainnet + customDomain', () => {
      const spec: SingleServiceSpec = {
        image: 'app:1',
        customDomain: 'app.example.com',
      };
      const out = renderIntentRecap({ spec, activeChain: 'mainnet' });
      expect(out).toContain(
        'Mainnet warning: this transaction permanently associates app.example.com',
      );
    });
  });

  describe('input validation', () => {
    it('throws TypeError when activeChain is not "testnet" or "mainnet"', () => {
      const spec: SingleServiceSpec = { image: 'app:1' };
      expect(() =>
        renderIntentRecap({
          spec,
          activeChain: 'devnet' as unknown as 'testnet',
        }),
      ).toThrow(/activeChain must be "testnet" or "mainnet"/);
    });
  });

  describe('byte-baseline parity', () => {
    it('matches expected output for 01-fast-path-active fixture', () => {
      const spec = JSON.parse(
        readFixture(
          'skills',
          'deploy-app',
          '01-fast-path-active',
          'input',
          'spec.json',
        ),
      ) as DeploySpec;
      const expected = readFixture(
        'skills',
        'deploy-app',
        '01-fast-path-active',
        'expected-intent-recap.txt',
      );
      const actual = renderIntentRecap({ spec, activeChain: 'testnet' });
      // The captured fixture has a trailing newline (CJS uses console.log
      // which appends \n); the TS function returns the rendered text
      // without trailing newline. Strip for comparison.
      expect(actual).toBe(expected.replace(/\n$/, ''));
    });

    it('matches expected output for 03-partial-success-set-domain-failed fixture', () => {
      const spec = JSON.parse(
        readFixture(
          'skills',
          'deploy-app',
          '03-partial-success-set-domain-failed',
          'input',
          'spec.json',
        ),
      ) as DeploySpec;
      const expected = readFixture(
        'skills',
        'deploy-app',
        '03-partial-success-set-domain-failed',
        'expected-intent-recap.txt',
      );
      const actual = renderIntentRecap({ spec, activeChain: 'testnet' });
      expect(actual).toBe(expected.replace(/\n$/, ''));
    });
  });
});
