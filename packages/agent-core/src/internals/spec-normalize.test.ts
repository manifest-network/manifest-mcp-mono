import { describe, expect, it } from 'vitest';
import type { DeploySpec, SingleServiceSpec, StackSpec } from '../types.js';
import {
  firstImage,
  isStackSpec,
  normalizeServices,
  summarizeSpec,
  validateSpec,
} from './spec-normalize.js';

describe('isStackSpec', () => {
  it('returns true for valid stack spec', () => {
    const spec: StackSpec = { services: { web: { image: 'nginx:1.27' } } };
    expect(isStackSpec(spec)).toBe(true);
  });

  it('returns false for legacy single-service spec', () => {
    const spec: SingleServiceSpec = { image: 'nginx:1.27', port: 80 };
    expect(isStackSpec(spec)).toBe(false);
  });

  it('returns false when services is null / array / non-object', () => {
    expect(isStackSpec({ services: null } as unknown as DeploySpec)).toBe(
      false,
    );
    expect(isStackSpec({ services: [] } as unknown as DeploySpec)).toBe(false);
    expect(isStackSpec({ services: 'string' } as unknown as DeploySpec)).toBe(
      false,
    );
  });

  it('returns false for null / undefined / non-object input', () => {
    expect(isStackSpec(null)).toBe(false);
    expect(isStackSpec(undefined)).toBe(false);
  });
});

describe('firstImage', () => {
  it('returns spec.image for legacy single-service spec', () => {
    expect(firstImage({ image: 'nginx:1.27', port: 80 })).toBe('nginx:1.27');
  });

  it('returns the first service image for stack spec', () => {
    const spec: StackSpec = {
      services: {
        web: { image: 'nginx:1.27' },
        db: { image: 'postgres:16' },
      },
    };
    expect(firstImage(spec)).toBe('nginx:1.27');
  });

  it('returns null when no image is present', () => {
    expect(firstImage({} as DeploySpec)).toBeNull();
    expect(firstImage({ services: {} } as StackSpec)).toBeNull();
  });

  it('returns null for null / undefined / non-object', () => {
    expect(firstImage(null)).toBeNull();
    expect(firstImage(undefined)).toBeNull();
  });

  it('skips empty-string images in stack spec', () => {
    const spec = {
      services: {
        empty: { image: '' },
        web: { image: 'nginx:1.27' },
      },
    } as StackSpec;
    expect(firstImage(spec)).toBe('nginx:1.27');
  });
});

describe('normalizeServices', () => {
  it('returns [{name: null, raw: spec}] for legacy single-service', () => {
    const spec: SingleServiceSpec = { image: 'nginx:1.27', port: 80 };
    expect(normalizeServices(spec)).toEqual([{ name: null, raw: spec }]);
  });

  it('returns [{name, raw}] entries for each service in stack spec', () => {
    const spec: StackSpec = {
      services: {
        web: { image: 'nginx:1.27' },
        db: { image: 'postgres:16' },
      },
    };
    expect(normalizeServices(spec)).toEqual([
      { name: 'web', raw: { image: 'nginx:1.27' } },
      { name: 'db', raw: { image: 'postgres:16' } },
    ]);
  });

  it('substitutes empty object for missing service entry value', () => {
    const spec = {
      services: { web: null as unknown as { image: string } },
    } as StackSpec;
    expect(normalizeServices(spec)).toEqual([{ name: 'web', raw: {} }]);
  });

  it('returns [{name: null, raw: {}}] for null/undefined input', () => {
    expect(normalizeServices(null)).toEqual([{ name: null, raw: {} }]);
    expect(normalizeServices(undefined)).toEqual([{ name: null, raw: {} }]);
  });
});

describe('summarizeSpec', () => {
  it('summarizes a single-service spec with port: number', () => {
    const spec: SingleServiceSpec = {
      image: 'nginx:1.27',
      port: 80,
      env: { NODE_ENV: 'production', PORT: '80' },
    };
    expect(summarizeSpec(spec)).toEqual({
      format: 'single',
      serviceCount: 1,
      portCount: 1,
      envCount: 2,
      envKeys: ['NODE_ENV', 'PORT'],
      images: ['nginx:1.27'],
    });
  });

  it('summarizes a single-service spec with port: number[]', () => {
    const spec = {
      image: 'app:latest',
      port: [80, 443, 8080],
    } as SingleServiceSpec;
    expect(summarizeSpec(spec).portCount).toBe(3);
  });

  it('summarizes a stack spec; envKeys are union across services, sorted', () => {
    const spec: StackSpec = {
      services: {
        web: {
          image: 'nginx:1.27',
          ports: [80],
          env: { B: 'b', A: 'a' },
        },
        db: {
          image: 'postgres:16',
          ports: [5432],
          env: { POSTGRES_PASSWORD: 'secret', A: 'a' /* duplicate */ },
        },
      },
    };
    const summary = summarizeSpec(spec);
    expect(summary).toEqual({
      format: 'stack',
      serviceCount: 2,
      portCount: 2,
      envCount: 3, // A, B, POSTGRES_PASSWORD (A deduped)
      envKeys: ['A', 'B', 'POSTGRES_PASSWORD'],
      images: ['nginx:1.27', 'postgres:16'],
    });
  });

  it('counts ports declared as a Record (older shape compatibility)', () => {
    const spec = {
      services: {
        web: {
          image: 'nginx:1.27',
          ports: { '80/tcp': {}, '443/tcp': {} },
        },
      },
    } as unknown as StackSpec;
    expect(summarizeSpec(spec).portCount).toBe(2);
  });

  it('produces empty images array when no image is set', () => {
    const spec = { services: {} } as StackSpec;
    expect(summarizeSpec(spec).images).toEqual([]);
  });

  it('skips empty-string images in the images list', () => {
    const spec = {
      services: {
        empty: { image: '' },
        web: { image: 'nginx:1.27' },
      },
    } as StackSpec;
    expect(summarizeSpec(spec).images).toEqual(['nginx:1.27']);
  });
});

describe('validateSpec', () => {
  it('accepts a valid single-service spec', () => {
    expect(() => validateSpec({ image: 'nginx:1.27', port: 80 })).not.toThrow();
  });

  it('accepts a valid stack spec', () => {
    expect(() =>
      validateSpec({ services: { web: { image: 'nginx:1.27' } } }),
    ).not.toThrow();
  });

  it('rejects null / undefined / non-object', () => {
    expect(() => validateSpec(null)).toThrow(TypeError);
    expect(() => validateSpec(undefined)).toThrow(/non-null object/);
  });

  it('rejects spec with neither image nor services', () => {
    expect(() => validateSpec({} as DeploySpec)).toThrow(
      /must declare either `image`.*or `services`/,
    );
  });

  it('rejects spec with both image AND services (mutually exclusive)', () => {
    expect(() =>
      validateSpec({
        image: 'nginx:1.27',
        services: { web: { image: 'nginx:1.27' } },
      } as unknown as DeploySpec),
    ).toThrow(/mutually exclusive/);
  });

  // Key-presence-vs-value-validity bypass vectors (Copilot PR #57 Comment 3).
  // The mutual-exclusion gate must reject on KEY presence, not value validity.
  // A caller that supplies a malformed `image` value alongside a valid
  // `services` map has ambiguous intent — accepting it (as the prior
  // value-based check did) silently coerced the spec to stack shape.
  it('rejects {image: "", services: {...}} (empty image bypass vector)', () => {
    expect(() =>
      validateSpec({
        image: '',
        services: { web: { image: 'nginx:1.27' } },
      } as unknown as DeploySpec),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects {image: 123, services: {...}} (non-string image bypass vector)', () => {
    expect(() =>
      validateSpec({
        image: 123,
        services: { web: { image: 'nginx:1.27' } },
      } as unknown as DeploySpec),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects {image: null, services: {...}} (null image bypass vector)', () => {
    expect(() =>
      validateSpec({
        image: null,
        services: { web: { image: 'nginx:1.27' } },
      } as unknown as DeploySpec),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects stack spec with empty services', () => {
    expect(() => validateSpec({ services: {} } as StackSpec)).toThrow(
      /at least one entry/,
    );
  });

  it('rejects stack service with missing image', () => {
    expect(() =>
      validateSpec({
        services: { web: {} as unknown as { image: string } },
      } as StackSpec),
    ).toThrow(/must declare a non-empty `image`/);
  });

  it('rejects stack service with empty image string', () => {
    expect(() =>
      validateSpec({ services: { web: { image: '' } } } as StackSpec),
    ).toThrow(/must declare a non-empty `image`/);
  });

  it('rejects stack service that is null/non-object', () => {
    expect(() =>
      validateSpec({
        services: { web: null as unknown as { image: string } },
      } as StackSpec),
    ).toThrow(/must be a non-null object/);
  });

  // Copilot review fix (PR #58 r3249097051): fred's image-mode rejects
  // portless inputs with `port is required when using image`. Failing
  // fast at the agent-core boundary produces a clearer error and
  // avoids partial orchestration work (readiness check + plan render)
  // before fred rejects mid-broadcast.
  describe('single-service port requirement', () => {
    it('rejects single-service spec without port (port absent)', () => {
      expect(() =>
        validateSpec({ image: 'alpine' } as unknown as DeploySpec),
      ).toThrow(/single-service specs require at least one port/);
    });

    it('rejects single-service spec with explicit port: undefined', () => {
      expect(() =>
        validateSpec({
          image: 'alpine',
          port: undefined,
        } as unknown as DeploySpec),
      ).toThrow(/single-service specs require at least one port/);
    });

    it('rejects single-service spec with empty port array', () => {
      expect(() =>
        validateSpec({ image: 'alpine', port: [] } as unknown as DeploySpec),
      ).toThrow(/single-service specs require at least one port/);
    });

    it('rejects single-service spec with non-number port', () => {
      expect(() =>
        validateSpec({
          image: 'alpine',
          port: 'eighty' as unknown as number,
        } as unknown as DeploySpec),
      ).toThrow(/single-service specs require at least one port/);
    });

    it('error message hints at stack-spec escape hatch for internal-only services', () => {
      expect(() =>
        validateSpec({ image: 'alpine' } as unknown as DeploySpec),
      ).toThrow(/For internal-only services, use a stack spec/);
    });

    it('accepts single-service spec with port: number', () => {
      expect(() => validateSpec({ image: 'alpine', port: 80 })).not.toThrow();
    });

    it('accepts single-service spec with port: non-empty number array', () => {
      expect(() =>
        validateSpec({ image: 'alpine', port: [80, 443] }),
      ).not.toThrow();
    });

    it('accepts stack spec WITHOUT any port (internal-only escape hatch)', () => {
      // Stack services have ports declared per-service and the
      // single-service port check does NOT apply. This is the
      // documented escape hatch in the error message.
      expect(() =>
        validateSpec({ services: { internal: { image: 'alpine' } } }),
      ).not.toThrow();
    });

    // Copilot review fix (PR #58 r3249294877): port predicate must
    // reject non-finite, non-integer, and out-of-range numbers — not
    // just non-`number` typeof bypasses. TCP port range is 1-65535.
    describe('port-number validity (r3249294877)', () => {
      it('rejects port: 0 (TCP reserved, fred catches with !input.port)', () => {
        expect(() =>
          validateSpec({
            image: 'alpine',
            port: 0,
          } as unknown as DeploySpec),
        ).toThrow(/finite positive integer in the TCP range/);
      });

      it('rejects port: -1', () => {
        expect(() =>
          validateSpec({
            image: 'alpine',
            port: -1,
          } as unknown as DeploySpec),
        ).toThrow(/finite positive integer in the TCP range/);
      });

      it('rejects port: NaN', () => {
        expect(() =>
          validateSpec({
            image: 'alpine',
            port: Number.NaN,
          } as unknown as DeploySpec),
        ).toThrow(/finite positive integer in the TCP range/);
      });

      it('rejects port: Infinity', () => {
        expect(() =>
          validateSpec({
            image: 'alpine',
            port: Number.POSITIVE_INFINITY,
          } as unknown as DeploySpec),
        ).toThrow(/finite positive integer in the TCP range/);
      });

      it('rejects port: 1.5 (non-integer)', () => {
        expect(() =>
          validateSpec({
            image: 'alpine',
            port: 1.5,
          } as unknown as DeploySpec),
        ).toThrow(/finite positive integer in the TCP range/);
      });

      it('rejects port: 65536 (above TCP range)', () => {
        expect(() =>
          validateSpec({
            image: 'alpine',
            port: 65536,
          } as unknown as DeploySpec),
        ).toThrow(/finite positive integer in the TCP range/);
      });

      it('rejects port array with NaN entry (mixed validity)', () => {
        expect(() =>
          validateSpec({
            image: 'alpine',
            port: [80, Number.NaN],
          } as unknown as DeploySpec),
        ).toThrow(/finite positive integer in the TCP range/);
      });

      it('rejects port array with 0 entry (mixed validity)', () => {
        expect(() =>
          validateSpec({
            image: 'alpine',
            port: [80, 0],
          } as unknown as DeploySpec),
        ).toThrow(/finite positive integer in the TCP range/);
      });

      it('accepts port: 1 (lower boundary)', () => {
        expect(() => validateSpec({ image: 'alpine', port: 1 })).not.toThrow();
      });

      it('accepts port: 65535 (upper boundary)', () => {
        expect(() =>
          validateSpec({ image: 'alpine', port: 65535 }),
        ).not.toThrow();
      });
    });
  });

  // Copilot review fix (PR #58 r3249684707): stack-with-customDomain
  // must declare serviceName + that name must be a key in services.
  // Without this gate, set-domain failure orphan-leases the tenant.
  describe('stack customDomain + serviceName invariant (r3249684707)', () => {
    it('rejects stack + customDomain without serviceName', () => {
      expect(() =>
        validateSpec({
          services: { web: { image: 'nginx:1.27' } },
          customDomain: 'app.example.com',
        } as unknown as DeploySpec),
      ).toThrow(/customDomain.*requires.*serviceName/);
    });

    it('rejects stack + customDomain + empty-string serviceName', () => {
      expect(() =>
        validateSpec({
          services: { web: { image: 'nginx:1.27' } },
          customDomain: 'app.example.com',
          serviceName: '',
        } as unknown as DeploySpec),
      ).toThrow(/customDomain.*requires.*serviceName/);
    });

    it('rejects stack + customDomain + serviceName not in services', () => {
      expect(() =>
        validateSpec({
          services: { db: { image: 'postgres:16' } },
          customDomain: 'app.example.com',
          serviceName: 'web',
        } as unknown as DeploySpec),
      ).toThrow(/serviceName.*"web".*must be a key in.*services.*db/);
    });

    // Copilot review fix (PR #58 r3250331968): the prior `in`-operator
    // check walked the prototype chain, so `'constructor' in {}` would
    // return true. Switched to `Object.keys(...).includes(...)` to
    // match fred's own-key check at
    // `packages/fred/src/tools/deployApp.ts:254`. This regression test
    // pins the boundary.
    it('rejects stack + customDomain + serviceName matching a prototype-chain key (own-key check)', () => {
      expect(() =>
        validateSpec({
          services: { web: { image: 'nginx:1.27' } },
          customDomain: 'app.example.com',
          serviceName: 'constructor',
        } as unknown as DeploySpec),
      ).toThrow(/serviceName.*"constructor".*must be a key in.*services.*web/);
    });

    it('accepts stack + customDomain + serviceName matching a services key', () => {
      expect(() =>
        validateSpec({
          services: { web: { image: 'nginx:1.27' } },
          customDomain: 'app.example.com',
          serviceName: 'web',
        } as unknown as DeploySpec),
      ).not.toThrow();
    });

    it('accepts stack WITHOUT customDomain (no serviceName required)', () => {
      // Escape hatch preserved — internal-only stack deploys don't need
      // either field.
      expect(() =>
        validateSpec({ services: { internal: { image: 'alpine' } } }),
      ).not.toThrow();
    });

    it('accepts single-service + customDomain (rule is stack-only)', () => {
      // Single-service customDomain is claimed against the implicit
      // single lease item — no serviceName disambiguation needed.
      expect(() =>
        validateSpec({
          image: 'nginx:1.27',
          port: 80,
          customDomain: 'app.example.com',
        } as unknown as DeploySpec),
      ).not.toThrow();
    });
  });

  // Copilot review fix (PR #58 r3266786899): `customDomain` shape at
  // the boundary. `buildFredDeployInput`'s `if (customDomain)`
  // truthiness check silently dropped `''` / `null` / etc. — the
  // user's spec passed validation, fred received `fredInput` without
  // the domain, deploy proceeded silently. Boundary check enforces
  // non-empty string when the key is present; `undefined` is fine.
  describe('customDomain shape (r3266786899)', () => {
    it('rejects single-service + customDomain: "" (empty string)', () => {
      expect(() =>
        validateSpec({
          image: 'nginx:1.27',
          port: 80,
          customDomain: '',
        } as unknown as DeploySpec),
      ).toThrow(/`customDomain` must be a non-empty string or absent.*""/);
    });

    it('rejects single-service + customDomain: null', () => {
      expect(() =>
        validateSpec({
          image: 'nginx:1.27',
          port: 80,
          customDomain: null,
        } as unknown as DeploySpec),
      ).toThrow(/`customDomain` must be a non-empty string or absent.*null/);
    });

    it('rejects single-service + customDomain: 0 (non-string)', () => {
      expect(() =>
        validateSpec({
          image: 'nginx:1.27',
          port: 80,
          customDomain: 0,
        } as unknown as DeploySpec),
      ).toThrow(/`customDomain` must be a non-empty string or absent.*number/);
    });

    it('accepts single-service + customDomain: undefined (key absent semantics)', () => {
      expect(() =>
        validateSpec({
          image: 'nginx:1.27',
          port: 80,
          customDomain: undefined,
        } as unknown as DeploySpec),
      ).not.toThrow();
    });

    it('accepts single-service + customDomain: valid FQDN string', () => {
      expect(() =>
        validateSpec({
          image: 'nginx:1.27',
          port: 80,
          customDomain: 'app.example.com',
        } as unknown as DeploySpec),
      ).not.toThrow();
    });

    // Order-dependent: the customDomain shape check fires BEFORE the
    // stack-customDomain-serviceName check (r3249684707). A stack
    // spec with `customDomain: ''` should surface as the shape error,
    // not as a misleading "requires serviceName" error.
    it('rejects stack + customDomain: "" with shape error (precedes serviceName check)', () => {
      let caughtErr: unknown = null;
      try {
        validateSpec({
          services: { web: { image: 'nginx:1.27' } },
          customDomain: '',
          serviceName: 'web',
        } as unknown as DeploySpec);
      } catch (err) {
        caughtErr = err;
      }
      expect(caughtErr).toBeInstanceOf(TypeError);
      const msg = (caughtErr as Error).message;
      expect(msg).toContain('`customDomain` must be a non-empty string');
      // Make sure the misleading serviceName message did NOT fire.
      expect(msg).not.toContain('requires `serviceName`');
    });

    it('accepts stack + valid customDomain + matching serviceName (regression guard)', () => {
      expect(() =>
        validateSpec({
          services: { web: { image: 'nginx:1.27' } },
          customDomain: 'app.example.com',
          serviceName: 'web',
        } as unknown as DeploySpec),
      ).not.toThrow();
    });
  });
});
