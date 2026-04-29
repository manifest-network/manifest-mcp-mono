import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  buildStackManifest,
  deriveAppNameFromImage,
  getServiceNames,
  isStackManifest,
  mergeManifest,
  metaHashHex,
  normalizePorts,
  parseStackManifest,
  validateManifest,
  validateServiceName,
} from './manifest.js';

describe('deriveAppNameFromImage', () => {
  it('simple image', () => {
    expect(deriveAppNameFromImage('nginx')).toBe('nginx');
  });

  it('image with tag stripped', () => {
    expect(deriveAppNameFromImage('redis:8.4')).toBe('redis');
  });

  it('latest tag stripped', () => {
    expect(deriveAppNameFromImage('nginx:latest')).toBe('nginx');
  });

  it('registry prefix stripped', () => {
    expect(deriveAppNameFromImage('ghcr.io/foo/bar:v2')).toBe('bar');
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
    // 30 a's + hyphen + more chars -> truncated at 32, trailing hyphen trimmed
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
    expect(result.depends_on).toEqual({
      db: { condition: 'service_healthy' },
    });
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
  it('builds multi-service stack with services wrapper', () => {
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
    expect(Object.keys(result)).toEqual(['services']);
    expect(Object.keys(result.services)).toEqual(['web', 'db']);
    expect(result.services.web).toEqual({
      image: 'nginx',
      ports: { '80/tcp': {} },
    });
    expect(result.services.db).toEqual({
      image: 'mysql:8',
      ports: { '3306/tcp': {} },
      env: { MYSQL_ROOT_PASSWORD: 'secret' },
    });
  });
});

describe('normalizePorts', () => {
  it('single port defaults to tcp', () => {
    expect(normalizePorts('80')).toEqual({ '80/tcp': {} });
  });

  it('explicit udp protocol', () => {
    expect(normalizePorts('53/udp')).toEqual({ '53/udp': {} });
  });

  it('comma-separated ports', () => {
    expect(normalizePorts('80, 443')).toEqual({
      '80/tcp': {},
      '443/tcp': {},
    });
  });

  it('mixed protocols', () => {
    expect(normalizePorts('8080/tcp,53/udp')).toEqual({
      '8080/tcp': {},
      '53/udp': {},
    });
  });

  it('port 1 is valid', () => {
    expect(normalizePorts('1')).toEqual({ '1/tcp': {} });
  });

  it('port 65535 is valid', () => {
    expect(normalizePorts('65535')).toEqual({ '65535/tcp': {} });
  });

  it('port 0 throws', () => {
    expect(() => normalizePorts('0')).toThrow('Invalid port');
  });

  it('port 65536 throws', () => {
    expect(() => normalizePorts('65536')).toThrow('Invalid port');
  });

  it('non-numeric port throws', () => {
    expect(() => normalizePorts('abc')).toThrow('Invalid port');
  });

  it('invalid protocol throws', () => {
    expect(() => normalizePorts('80/sctp')).toThrow('Invalid protocol');
  });

  it('leading zeros throw', () => {
    expect(() => normalizePorts('080')).toThrow('Invalid port');
  });

  it('empty string returns empty object', () => {
    expect(normalizePorts('')).toEqual({});
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
      JSON.stringify({
        image: 'nginx:1',
        labels: { app: 'old', env: 'prod' },
      }),
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

  it('wrapped stack manifest returns true', () => {
    expect(
      isStackManifest({
        services: {
          web: { image: 'nginx', ports: { '80/tcp': {} } },
          db: { image: 'mysql:8', ports: { '3306/tcp': {} } },
        },
      }),
    ).toBe(true);
  });

  it('single-service wrapped stack returns true', () => {
    expect(
      isStackManifest({
        services: { web: { image: 'nginx' } },
      }),
    ).toBe(true);
  });

  it('unwrapped stack (no services key) returns false', () => {
    expect(
      isStackManifest({
        web: { image: 'nginx', ports: { '80/tcp': {} } },
        db: { image: 'mysql:8', ports: { '3306/tcp': {} } },
      }),
    ).toBe(false);
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

  it('services is null returns false', () => {
    expect(isStackManifest({ services: null })).toBe(false);
  });

  it('services is array returns false', () => {
    expect(isStackManifest({ services: [1, 2] })).toBe(false);
  });

  it('services with no image entries returns false', () => {
    expect(isStackManifest({ services: { web: { ports: {} } } })).toBe(false);
  });

  it('empty services object returns false', () => {
    expect(isStackManifest({ services: {} })).toBe(false);
  });

  it('services with mixed object/non-object values returns false', () => {
    expect(
      isStackManifest({
        services: { web: { image: 'nginx' }, config: 'not-an-object' },
      }),
    ).toBe(false);
  });
});

describe('parseStackManifest', () => {
  it('parses valid wrapped stack manifest', () => {
    const json = JSON.stringify({
      services: {
        web: { image: 'nginx' },
        db: { image: 'mysql:8' },
      },
    });
    const result = parseStackManifest(json);
    expect(Object.keys(result.services)).toEqual(['web', 'db']);
    expect(result.services.web.image).toBe('nginx');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseStackManifest('not json')).toThrow();
  });

  it('throws on single-service manifest', () => {
    expect(() =>
      parseStackManifest(JSON.stringify({ image: 'nginx' })),
    ).toThrow(/Not a valid stack manifest/);
  });

  it('throws on unwrapped stack', () => {
    expect(() =>
      parseStackManifest(
        JSON.stringify({
          web: { image: 'nginx' },
          db: { image: 'mysql:8' },
        }),
      ),
    ).toThrow(/Not a valid stack manifest/);
  });
});

describe('getServiceNames', () => {
  it('returns keys for wrapped stack manifest', () => {
    expect(
      getServiceNames({
        services: {
          web: { image: 'nginx' },
          db: { image: 'mysql' },
        },
      }),
    ).toEqual(['web', 'db']);
  });

  it('returns empty array for single-service manifest', () => {
    expect(getServiceNames({ image: 'nginx', ports: {} })).toEqual([]);
  });

  it('returns empty array for non-object', () => {
    expect(getServiceNames(null)).toEqual([]);
  });

  it('returns empty array for unwrapped stack', () => {
    expect(
      getServiceNames({
        web: { image: 'nginx' },
        db: { image: 'mysql' },
      }),
    ).toEqual([]);
  });
});

describe('metaHashHex', () => {
  it('produces a 64-char lowercase hex SHA-256', async () => {
    const hash = await metaHashHex('{"image":"nginx"}');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same input', async () => {
    const a = await metaHashHex('{"image":"nginx"}');
    const b = await metaHashHex('{"image":"nginx"}');
    expect(a).toBe(b);
  });

  it('differs for different inputs', async () => {
    const a = await metaHashHex('{"image":"nginx"}');
    const b = await metaHashHex('{"image":"redis"}');
    expect(a).not.toBe(b);
  });
});

describe('validateManifest', () => {
  describe('structural', () => {
    it('rejects non-object input', () => {
      expect(validateManifest(null).valid).toBe(false);
      expect(validateManifest('foo').valid).toBe(false);
      expect(validateManifest([]).valid).toBe(false);
    });

    it('accepts a minimal single-service manifest', () => {
      const result = validateManifest({ image: 'nginx:latest' });
      expect(result.valid).toBe(true);
      expect(result.format).toBe('single');
    });

    it('detects stack format from services key', () => {
      const result = validateManifest({
        services: { web: { image: 'nginx' } },
      });
      expect(result.format).toBe('stack');
      expect(result.valid).toBe(true);
    });

    it('flags unknown top-level fields on a single manifest', () => {
      const result = validateManifest({ image: 'nginx', volumes: ['/data'] });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('volumes'))).toBe(true);
    });

    it('rejects empty services map', () => {
      const result = validateManifest({ services: {} });
      // isStackManifest requires at least one service so this is actually
      // detected as a single-service manifest with `services` as an unknown
      // top-level field. Either way, validation should fail.
      expect(result.valid).toBe(false);
    });
  });

  describe('env', () => {
    const cases: Array<[string, boolean]> = [
      ['DATABASE_URL', true],
      ['APP_PORT', true],
      ['PATH', false],
      ['path', false],
      ['LD_PRELOAD', false],
      ['ld_library_path', false],
      ['FRED_TOKEN', false],
      ['DOCKER_HOST', false],
    ];
    for (const [name, ok] of cases) {
      it(`${ok ? 'accepts' : 'blocks'} env name "${name}"`, () => {
        const r = validateManifest({
          image: 'nginx',
          env: { [name]: 'x' },
        });
        expect(r.valid).toBe(ok);
      });
    }
  });

  describe('labels', () => {
    it('accepts non-fred-prefix labels', () => {
      expect(
        validateManifest({
          image: 'nginx',
          labels: { app: 'myapp', version: '1.0' },
        }).valid,
      ).toBe(true);
    });

    it('rejects fred.* prefix', () => {
      const r = validateManifest({
        image: 'nginx',
        labels: { 'fred.lease': 'abc' },
      });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('fred.'))).toBe(true);
    });
  });

  describe('ports', () => {
    it('accepts port/protocol keys', () => {
      const r = validateManifest({
        image: 'nginx',
        ports: { '80/tcp': {}, '53/udp': {} },
      });
      expect(r.valid).toBe(true);
    });

    it('rejects bare port without protocol', () => {
      const r = validateManifest({ image: 'nginx', ports: { '80': {} } });
      expect(r.valid).toBe(false);
    });

    it('rejects unknown protocol', () => {
      const r = validateManifest({
        image: 'nginx',
        ports: { '80/sctp': {} },
      });
      expect(r.valid).toBe(false);
    });

    it('rejects ports above 65535', () => {
      // PORT_KEY_RE permits up to 5 digits, so the regex alone would let
      // 70000/tcp through. validatePort() closes the gap.
      const r = validateManifest({
        image: 'nginx',
        ports: { '70000/tcp': {} },
      });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('70000'))).toBe(true);
    });

    it('accepts the maximum legal port 65535/tcp', () => {
      const r = validateManifest({
        image: 'nginx',
        ports: { '65535/tcp': {} },
      });
      expect(r.valid).toBe(true);
    });
  });

  describe('tmpfs', () => {
    it('rejects more than 4 entries', () => {
      const r = validateManifest({
        image: 'nginx',
        tmpfs: ['/a', '/b', '/c', '/d', '/e'],
      });
      expect(r.valid).toBe(false);
    });

    it('rejects /tmp, /run, and sub-paths of /proc /sys /dev', () => {
      const blocked = ['/tmp', '/run', '/proc/x', '/sys/y', '/dev/null'];
      for (const path of blocked) {
        const r = validateManifest({ image: 'nginx', tmpfs: [path] });
        expect(r.valid, `path=${path}`).toBe(false);
      }
    });

    it('accepts well-formed mounts', () => {
      const r = validateManifest({
        image: 'nginx',
        tmpfs: ['/var/cache/app', '/run/mysqld'],
      });
      expect(r.valid).toBe(true);
    });
  });

  describe('depends_on', () => {
    it('rejects non-empty depends_on in single-service manifest', () => {
      const r = validateManifest({
        image: 'nginx',
        depends_on: { db: { condition: 'service_started' } },
      });
      expect(r.valid).toBe(false);
    });

    it('accepts depends_on referencing a sibling in stack', () => {
      const r = validateManifest({
        services: {
          web: {
            image: 'nginx',
            depends_on: { db: { condition: 'service_healthy' } },
          },
          db: {
            image: 'postgres',
            health_check: { test: ['CMD', 'pg_isready'] },
          },
        },
      });
      expect(r.valid).toBe(true);
    });

    it('rejects depends_on referencing an undefined service', () => {
      const r = validateManifest({
        services: {
          web: {
            image: 'nginx',
            depends_on: { ghost: { condition: 'service_started' } },
          },
        },
      });
      expect(r.valid).toBe(false);
    });

    it('rejects self-reference', () => {
      const r = validateManifest({
        services: {
          web: {
            image: 'nginx',
            depends_on: { web: { condition: 'service_started' } },
          },
        },
      });
      expect(r.valid).toBe(false);
    });
  });

  describe('health_check', () => {
    it('accepts CMD and CMD-SHELL forms', () => {
      const a = validateManifest({
        image: 'nginx',
        health_check: { test: ['CMD', 'curl', '-f', 'http://localhost'] },
      });
      const b = validateManifest({
        image: 'nginx',
        health_check: {
          test: ['CMD-SHELL', 'curl -f http://localhost || exit 1'],
        },
      });
      expect(a.valid).toBe(true);
      expect(b.valid).toBe(true);
    });

    it('rejects CMD without arguments', () => {
      const r = validateManifest({
        image: 'nginx',
        health_check: { test: ['CMD'] },
      });
      expect(r.valid).toBe(false);
    });

    it('accepts NONE as a single-element test', () => {
      const r = validateManifest({
        image: 'nginx',
        health_check: { test: ['NONE'] },
      });
      expect(r.valid).toBe(true);
    });

    it('rejects negative retries', () => {
      const r = validateManifest({
        image: 'nginx',
        health_check: { test: ['NONE'], retries: -1 },
      });
      expect(r.valid).toBe(false);
    });
  });

  describe('service names', () => {
    it('rejects uppercase service names in stack', () => {
      const r = validateManifest({ services: { Web: { image: 'nginx' } } });
      expect(r.valid).toBe(false);
    });

    it('rejects underscore in service names', () => {
      const r = validateManifest({ services: { my_db: { image: 'p' } } });
      expect(r.valid).toBe(false);
    });
  });
});
