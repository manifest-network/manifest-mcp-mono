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
});
