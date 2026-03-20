import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  buildStackManifest,
  deriveAppNameFromImage,
  getServiceNames,
  isStackManifest,
  mergeManifest,
  parseStackManifest,
  validateServiceName,
} from './manifest.js';

describe('deriveAppNameFromImage', () => {
  it('simple image', () => {
    expect(deriveAppNameFromImage('nginx')).toBe('nginx');
  });

  it('image with tag', () => {
    expect(deriveAppNameFromImage('redis:8.4')).toBe('redis-8-4');
  });

  it('latest tag stripped', () => {
    expect(deriveAppNameFromImage('nginx:latest')).toBe('nginx');
  });

  it('registry prefix stripped', () => {
    expect(deriveAppNameFromImage('ghcr.io/foo/bar:v2')).toBe('bar-v2');
  });

  it('digest stripped', () => {
    expect(deriveAppNameFromImage('nginx@sha256:abc')).toBe('nginx');
  });

  it('registry + digest stripped', () => {
    expect(
      deriveAppNameFromImage('my-registry.com/org/my-app@sha256:abc123'),
    ).toBe('my-app');
  });

  it('long name truncated to 32 chars', () => {
    const long = 'a'.repeat(50);
    const result = deriveAppNameFromImage(long);
    expect(result.length).toBeLessThanOrEqual(32);
  });

  it('special characters normalized', () => {
    expect(deriveAppNameFromImage('my_app.v2')).toBe('my-app-v2');
  });

  it('consecutive hyphens collapsed', () => {
    expect(deriveAppNameFromImage('foo--bar')).toBe('foo-bar');
  });

  it('leading/trailing hyphens trimmed', () => {
    expect(deriveAppNameFromImage('-foo-')).toBe('foo');
  });

  it('truncation does not leave trailing hyphen', () => {
    // 30 a's + hyphen + more chars → truncated at 32, trailing hyphen trimmed
    const img = `${'a'.repeat(30)}-${'b'.repeat(10)}`;
    const result = deriveAppNameFromImage(img);
    expect(result.length).toBeLessThanOrEqual(32);
    expect(result).not.toMatch(/-$/);
  });
});

describe('validateServiceName', () => {
  it.each(['web', 'db', 'my-service', 'a', 'a1', '0'])('valid: %s', (name) => {
    expect(validateServiceName(name)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['Web', 'uppercase'],
    ['-web', 'leading hyphen'],
    ['web-', 'trailing hyphen'],
    ['a'.repeat(64), 'too long (64 chars)'],
    ['web.db', 'dot'],
    ['web_db', 'underscore'],
  ])('invalid: %s (%s)', (name) => {
    expect(validateServiceName(name)).toBe(false);
  });

  it('accepts max length (63 chars)', () => {
    expect(validateServiceName('a'.repeat(63))).toBe(true);
  });
});

describe('buildManifest', () => {
  it('minimal: just image + ports', () => {
    const result = buildManifest({
      image: 'nginx:alpine',
      ports: { '80/tcp': {} },
    });
    expect(result).toEqual({
      image: 'nginx:alpine',
      ports: { '80/tcp': {} },
    });
  });

  it('full: all optional fields included', () => {
    const result = buildManifest({
      image: 'nginx:alpine',
      ports: { '80/tcp': {} },
      env: { FOO: 'bar' },
      command: ['/bin/sh'],
      args: ['-c', 'echo hello'],
      user: '1000:1000',
      tmpfs: ['/tmp:size=64M'],
      health_check: {
        test: ['CMD', 'curl', '-f', 'http://localhost/'],
        interval: '30s',
        retries: 3,
      },
      stop_grace_period: '30s',
      init: true,
      expose: ['8080/tcp'],
      labels: { app: 'test' },
      depends_on: { db: { condition: 'service_healthy' } },
    });
    expect(result.image).toBe('nginx:alpine');
    expect(result.env).toEqual({ FOO: 'bar' });
    expect(result.command).toEqual(['/bin/sh']);
    expect(result.args).toEqual(['-c', 'echo hello']);
    expect(result.user).toBe('1000:1000');
    expect(result.tmpfs).toEqual(['/tmp:size=64M']);
    expect(result.health_check).toEqual({
      test: ['CMD', 'curl', '-f', 'http://localhost/'],
      interval: '30s',
      retries: 3,
    });
    expect(result.stop_grace_period).toBe('30s');
    expect(result.init).toBe(true);
    expect(result.expose).toEqual(['8080/tcp']);
    expect(result.labels).toEqual({ app: 'test' });
    expect(result.depends_on).toEqual({ db: { condition: 'service_healthy' } });
  });

  it('optional fields omitted when not provided', () => {
    const result = buildManifest({
      image: 'nginx',
      ports: { '80/tcp': {} },
    });
    expect(Object.keys(result)).toEqual(['image', 'ports']);
  });

  it('includes init=false when explicitly set', () => {
    const result = buildManifest({
      image: 'nginx',
      ports: { '80/tcp': {} },
      init: false,
    });
    expect(result.init).toBe(false);
  });
});

describe('buildStackManifest', () => {
  it('builds multi-service stack', () => {
    const result = buildStackManifest({
      services: {
        web: { image: 'nginx', ports: { '80/tcp': {} } },
        db: {
          image: 'mysql:8',
          ports: { '3306/tcp': {} },
          env: { MYSQL_ROOT_PASSWORD: 'secret' },
        },
      },
    });
    expect(Object.keys(result)).toEqual(['web', 'db']);
    expect(result.web).toEqual({ image: 'nginx', ports: { '80/tcp': {} } });
    expect(result.db).toEqual({
      image: 'mysql:8',
      ports: { '3306/tcp': {} },
      env: { MYSQL_ROOT_PASSWORD: 'secret' },
    });
  });
});

describe('mergeManifest', () => {
  it('env merged: old defaults, new overrides', () => {
    const result = mergeManifest(
      { image: 'nginx:2', env: { FOO: 'new', BAZ: 'added' } },
      JSON.stringify({ image: 'nginx:1', env: { FOO: 'old', BAR: 'kept' } }),
    );
    expect(result.env).toEqual({ FOO: 'new', BAR: 'kept', BAZ: 'added' });
  });

  it('ports unioned', () => {
    const result = mergeManifest(
      { image: 'nginx:2', ports: { '443/tcp': {} } },
      JSON.stringify({ image: 'nginx:1', ports: { '80/tcp': {} } }),
    );
    expect(result.ports).toEqual({ '80/tcp': {}, '443/tcp': {} });
  });

  it('labels merged: old defaults, new overrides', () => {
    const result = mergeManifest(
      { image: 'nginx:2', labels: { app: 'new', tier: 'web' } },
      JSON.stringify({ image: 'nginx:1', labels: { app: 'old', env: 'prod' } }),
    );
    expect(result.labels).toEqual({ app: 'new', env: 'prod', tier: 'web' });
  });

  it('fields carried forward from old when not in new', () => {
    const result = mergeManifest(
      { image: 'nginx:2' },
      JSON.stringify({
        image: 'nginx:1',
        user: '1000:1000',
        tmpfs: ['/tmp'],
        command: ['/bin/sh'],
      }),
    );
    expect(result.image).toBe('nginx:2');
    expect(result.user).toBe('1000:1000');
    expect(result.tmpfs).toEqual(['/tmp']);
    expect(result.command).toEqual(['/bin/sh']);
  });

  it('new image always wins', () => {
    const result = mergeManifest(
      { image: 'nginx:2' },
      JSON.stringify({ image: 'nginx:1' }),
    );
    expect(result.image).toBe('nginx:2');
  });

  it('invalid old JSON throws', () => {
    const newManifest = { image: 'nginx:2', ports: { '80/tcp': {} } };
    expect(() => mergeManifest(newManifest, 'not valid json')).toThrow(
      'invalid JSON',
    );
  });

  it('old manifest that is an array throws', () => {
    const newManifest = { image: 'nginx:2' };
    expect(() => mergeManifest(newManifest, '[1, 2, 3]')).toThrow(
      'must be a JSON object',
    );
  });
});

describe('isStackManifest', () => {
  it('single-service manifest returns false', () => {
    expect(isStackManifest({ image: 'nginx', ports: { '80/tcp': {} } })).toBe(
      false,
    );
  });

  it('stack manifest returns true', () => {
    expect(
      isStackManifest({
        web: { image: 'nginx', ports: { '80/tcp': {} } },
        db: { image: 'mysql:8', ports: { '3306/tcp': {} } },
      }),
    ).toBe(true);
  });

  it('null returns false', () => {
    expect(isStackManifest(null)).toBe(false);
  });

  it('array returns false', () => {
    expect(isStackManifest([1, 2])).toBe(false);
  });

  it('empty object returns false', () => {
    expect(isStackManifest({})).toBe(false);
  });
});

describe('parseStackManifest', () => {
  it('parses valid stack manifest', () => {
    const json = JSON.stringify({
      web: { image: 'nginx' },
      db: { image: 'mysql:8' },
    });
    const result = parseStackManifest(json);
    expect(Object.keys(result)).toEqual(['web', 'db']);
    expect(result.web.image).toBe('nginx');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseStackManifest('not json')).toThrow();
  });

  it('throws on single-service manifest', () => {
    expect(() =>
      parseStackManifest(JSON.stringify({ image: 'nginx' })),
    ).toThrow(/Not a valid stack manifest/);
  });
});

describe('getServiceNames', () => {
  it('returns keys for stack manifest', () => {
    expect(
      getServiceNames({
        web: { image: 'nginx' },
        db: { image: 'mysql' },
      }),
    ).toEqual(['web', 'db']);
  });

  it('returns empty array for single-service manifest', () => {
    expect(getServiceNames({ image: 'nginx', ports: {} })).toEqual([]);
  });

  it('returns empty array for non-object', () => {
    expect(getServiceNames(null)).toEqual([]);
  });
});
