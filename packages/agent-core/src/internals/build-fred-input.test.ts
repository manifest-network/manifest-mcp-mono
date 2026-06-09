import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { describe, expect, it } from 'vitest';
import type { SingleServiceSpec, StackSpec } from '../types.js';
import {
  buildFredDeployInput,
  buildManifestPreviewInput,
} from './build-fred-input.js';

// ENG-185 sub-PR A item 2 — type-safe DeploySpec → fred input builders.
//
// Coverage matrix (locked by the parent task description):
//
//   - single-service single port: `port: 80` → fred `port: 80`
//   - single-service multi-port:  `port: [80, 443]` → INVALID_CONFIG (strategy (a))
//   - stack single port:          `ServiceDef.ports: [80]` → `{ '80/tcp': {} }`
//   - stack multi-port:           `[80, 443, 8080]` → `{ '80/tcp': {}, '443/tcp': {}, '8080/tcp': {} }`
//   - stack ports absent:         preview+fred services map omits `ports`
//   - single-service env passthrough
//   - stack + customDomain + serviceName threaded
//   - core regression guarantee: preview-input port-shape ≡ fred-input port-shape

describe('buildFredDeployInput — single-service', () => {
  it('passes a `port: number` through unchanged', () => {
    const spec: SingleServiceSpec = { image: 'nginx:1.27', port: 80 };
    const out = buildFredDeployInput(spec, 'small');
    expect(out).toEqual({
      size: 'small',
      image: 'nginx:1.27',
      port: 80,
    });
  });

  it('passes `env` through unchanged', () => {
    const spec: SingleServiceSpec = {
      image: 'nginx:1.27',
      port: 80,
      env: { NGINX_HOST: 'example.com', NGINX_PORT: '80' },
    };
    const out = buildFredDeployInput(spec, 'small');
    expect(out.env).toEqual({ NGINX_HOST: 'example.com', NGINX_PORT: '80' });
  });

  it('passes a single-element `port: [80]` through as `port: 80` (sole-port array)', () => {
    // Single-element array is unambiguous — the silent-truncation bug only
    // applies to multi-element arrays. Allowing this preserves behavior for
    // any caller that already passed a length-1 array.
    const spec = { image: 'nginx:1.27', port: [80] } as SingleServiceSpec;
    const out = buildFredDeployInput(spec, 'small');
    expect(out.port).toBe(80);
  });

  it('throws INVALID_CONFIG on multi-port single-service (strategy (a) — kills silent truncation)', () => {
    const spec = {
      image: 'nginx:1.27',
      port: [80, 443],
    } as SingleServiceSpec;
    expect(() => buildFredDeployInput(spec, 'small')).toThrow(ManifestMCPError);
    try {
      buildFredDeployInput(spec, 'small');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestMCPError);
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
      // Diagnostic surface mentions the foot-gun + the escape hatch (stack).
      expect((err as ManifestMCPError).message).toMatch(
        /multi-port.+single-service|stack/i,
      );
    }
  });

  it('threads `customDomain` (no `serviceName` for single-service)', () => {
    const spec: SingleServiceSpec = {
      image: 'nginx:1.27',
      port: 80,
      customDomain: 'app.example.com',
    };
    const out = buildFredDeployInput(spec, 'small');
    expect(out.customDomain).toBe('app.example.com');
    expect(out.serviceName).toBeUndefined();
  });
});

describe('buildFredDeployInput — stack', () => {
  it('converts `ports: [80]` to fred `{ "80/tcp": {} }`', () => {
    const spec: StackSpec = {
      services: {
        web: { image: 'nginx:1.27', ports: [80] },
      },
    };
    const out = buildFredDeployInput(spec, 'small');
    expect(out.services).toEqual({
      web: { image: 'nginx:1.27', ports: { '80/tcp': {} } },
    });
  });

  it('converts `ports: [80, 443, 8080]` to fred `{ "80/tcp": {}, "443/tcp": {}, "8080/tcp": {} }`', () => {
    const spec: StackSpec = {
      services: {
        web: { image: 'nginx:1.27', ports: [80, 443, 8080] },
      },
    };
    const out = buildFredDeployInput(spec, 'small');
    expect(out.services?.web.ports).toEqual({
      '80/tcp': {},
      '443/tcp': {},
      '8080/tcp': {},
    });
  });

  it('omits the `ports` field on services that declare none', () => {
    const spec: StackSpec = {
      services: {
        worker: { image: 'sidekiq:7' }, // no ports — internal-only service
      },
    };
    const out = buildFredDeployInput(spec, 'small');
    expect(out.services?.worker).toEqual({ image: 'sidekiq:7' });
    expect('ports' in (out.services?.worker ?? {})).toBe(false);
  });

  it('threads multi-service stack + customDomain + serviceName', () => {
    const spec: StackSpec = {
      services: {
        web: {
          image: 'nginx:1.27',
          ports: [80, 443],
          env: { NGINX_HOST: 'example.com' },
        },
        db: { image: 'postgres:16' },
      },
      customDomain: 'app.example.com',
      serviceName: 'web',
    };
    const out = buildFredDeployInput(spec, 'small');
    expect(out.size).toBe('small');
    expect(out.customDomain).toBe('app.example.com');
    expect(out.serviceName).toBe('web');
    expect(out.services).toEqual({
      web: {
        image: 'nginx:1.27',
        ports: { '80/tcp': {}, '443/tcp': {} },
        env: { NGINX_HOST: 'example.com' },
      },
      db: { image: 'postgres:16' },
    });
    // `image`/`port` MUST NOT leak onto the top-level when narrowing to stack.
    expect(out.image).toBeUndefined();
    expect(out.port).toBeUndefined();
  });

  it('passes `args` and `command` through unchanged on stack services', () => {
    const spec: StackSpec = {
      services: {
        web: {
          image: 'nginx:1.27',
          ports: [80],
          command: ['/bin/sh'],
          args: ['-c', 'nginx -g "daemon off;"'],
        },
      },
    };
    const out = buildFredDeployInput(spec, 'small');
    expect(out.services?.web.command).toEqual(['/bin/sh']);
    expect(out.services?.web.args).toEqual(['-c', 'nginx -g "daemon off;"']);
  });
});

describe('buildManifestPreviewInput — single-service', () => {
  it('passes a `port: number` through unchanged', () => {
    const spec: SingleServiceSpec = { image: 'nginx:1.27', port: 80 };
    const out = buildManifestPreviewInput(spec, 'small');
    // `size` is intentionally dropped — fred's BuildManifestPreviewInput
    // type has no `size` field; the prior inline builder leaked it via
    // an `as unknown as` cast that hid the type-contract violation.
    expect(out).toEqual({ image: 'nginx:1.27', port: 80 });
    expect(out).not.toHaveProperty('size');
  });

  it('passes `env` through unchanged', () => {
    const spec: SingleServiceSpec = {
      image: 'nginx:1.27',
      port: 80,
      env: { NGINX_HOST: 'example.com' },
    };
    const out = buildManifestPreviewInput(spec, 'small');
    expect(out.env).toEqual({ NGINX_HOST: 'example.com' });
  });

  it('passes single-element `port: [80]` as `port: 80`', () => {
    const spec = { image: 'nginx:1.27', port: [80] } as SingleServiceSpec;
    const out = buildManifestPreviewInput(spec, 'small');
    expect(out.port).toBe(80);
  });

  it('throws INVALID_CONFIG on multi-port single-service', () => {
    const spec = {
      image: 'nginx:1.27',
      port: [80, 443],
    } as SingleServiceSpec;
    expect(() => buildManifestPreviewInput(spec, 'small')).toThrow(
      ManifestMCPError,
    );
    try {
      buildManifestPreviewInput(spec, 'small');
    } catch (err) {
      expect((err as ManifestMCPError).code).toBe(
        ManifestMCPErrorCode.INVALID_CONFIG,
      );
    }
  });
});

describe('buildManifestPreviewInput — stack', () => {
  it('converts `ports: [80]` to fred `{ "80/tcp": {} }`', () => {
    const spec: StackSpec = {
      services: { web: { image: 'nginx:1.27', ports: [80] } },
    };
    const out = buildManifestPreviewInput(spec, 'small');
    expect(out.services).toEqual({
      web: { image: 'nginx:1.27', ports: { '80/tcp': {} } },
    });
  });

  it('converts multi-port `ports: [80, 443, 8080]` to `{ "80/tcp": {}, "443/tcp": {}, "8080/tcp": {} }`', () => {
    const spec: StackSpec = {
      services: {
        web: { image: 'nginx:1.27', ports: [80, 443, 8080] },
      },
    };
    const out = buildManifestPreviewInput(spec, 'small');
    expect(out.services?.web.ports).toEqual({
      '80/tcp': {},
      '443/tcp': {},
      '8080/tcp': {},
    });
  });

  it('omits the `ports` field on services that declare none', () => {
    const spec: StackSpec = {
      services: { worker: { image: 'sidekiq:7' } },
    };
    const out = buildManifestPreviewInput(spec, 'small');
    expect(out.services?.worker).toEqual({ image: 'sidekiq:7' });
    expect('ports' in (out.services?.worker ?? {})).toBe(false);
  });

  it('does NOT leak the deploy-only `customDomain`/`serviceName` onto preview input', () => {
    // `buildManifestPreview` is a pre-broadcast hash-computing path — it
    // doesn't take a `customDomain`/`serviceName`; those are only fred-
    // deploy-input concerns. The builder must drop them from the preview.
    const spec: StackSpec = {
      services: { web: { image: 'nginx:1.27', ports: [80] } },
      customDomain: 'app.example.com',
      serviceName: 'web',
    };
    const out = buildManifestPreviewInput(spec, 'small');
    expect(out).not.toHaveProperty('customDomain');
    expect(out).not.toHaveProperty('serviceName');
  });
});

describe('buildFredDeployInput — ENG-258 pin passthrough', () => {
  it('threads the pinned skuUuid/providerUuid into the fred input', () => {
    const out = buildFredDeployInput({ image: 'nginx', port: 80 } as never, 'docker-micro', {
      skuUuid: 'sku-p2',
      providerUuid: 'p2',
    });
    expect(out).toMatchObject({ size: 'docker-micro', skuUuid: 'sku-p2', providerUuid: 'p2' });
  });

  it('omits skuUuid/providerUuid when no pin provided (backward compat)', () => {
    const out = buildFredDeployInput({ image: 'nginx', port: 80 } as never, 'docker-micro');
    expect(out).not.toHaveProperty('skuUuid');
    expect(out).not.toHaveProperty('providerUuid');
  });
});

describe('preview-input ports shape ≡ fred-input ports shape (core regression guarantee)', () => {
  // The preview path computes `meta_hash_hex` recorded on-chain; the fred
  // path uploads the manifest the provider runs. If their port shapes
  // diverge, the hash drifts from the deployed manifest and the
  // create-lease tx commits to a different blob than the provider
  // serves — silent-data-loss class bug. This block locks the
  // equivalence in.

  function stackSpec(ports: number[]): StackSpec {
    return { services: { web: { image: 'nginx:1.27', ports } } };
  }

  it('stack single-port: preview.services.web.ports ≡ fred.services.web.ports', () => {
    const spec = stackSpec([80]);
    const preview = buildManifestPreviewInput(spec, 'small');
    const fred = buildFredDeployInput(spec, 'small');
    expect(preview.services?.web.ports).toEqual(fred.services?.web.ports);
    expect(preview.services?.web.ports).toEqual({ '80/tcp': {} });
  });

  it('stack multi-port: preview.services.web.ports ≡ fred.services.web.ports', () => {
    const spec = stackSpec([80, 443, 8080]);
    const preview = buildManifestPreviewInput(spec, 'small');
    const fred = buildFredDeployInput(spec, 'small');
    expect(preview.services?.web.ports).toEqual(fred.services?.web.ports);
  });

  it('single-service: preview.port ≡ fred.port', () => {
    const spec: SingleServiceSpec = { image: 'nginx:1.27', port: 80 };
    const preview = buildManifestPreviewInput(spec, 'small');
    const fred = buildFredDeployInput(spec, 'small');
    expect(preview.port).toBe(fred.port);
    expect(preview.port).toBe(80);
  });
});
