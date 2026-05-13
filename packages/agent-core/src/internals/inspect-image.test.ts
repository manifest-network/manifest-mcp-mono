import { describe, expect, it, vi } from 'vitest';
import { inspectImage } from './inspect-image.js';

/**
 * Build a deterministic fetch implementation from a script of canned
 * responses keyed by URL substring. Returns the first canned response
 * whose `urlMatch` is a substring of the requested URL. Stateless —
 * repeated calls to the same URL return the same canned response.
 */
interface CannedResponse {
  /** Substring match against the requested URL. */
  urlMatch: string;
  status: number;
  headers?: Record<string, string>;
  body: string;
}

function makeCannedFetch(responses: CannedResponse[]): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const canned = responses.find((r) => url.includes(r.urlMatch));
    if (!canned) {
      throw new Error(`canned-fetch: no response for URL ${url}`);
    }
    const body = new TextEncoder().encode(canned.body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
    return new Response(stream, {
      status: canned.status,
      headers: canned.headers ?? {},
    });
  };
}

const DOCKER_TOKEN_OK: CannedResponse = {
  urlMatch: 'auth.docker.io/token',
  status: 200,
  body: JSON.stringify({ token: 'canned-token-xyz' }),
};

const NGINX_MANIFEST_INDEX: CannedResponse = {
  urlMatch: '/manifests/1.27',
  status: 200,
  headers: {
    'content-type': 'application/vnd.docker.distribution.manifest.list.v2+json',
    'docker-content-digest':
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  },
  body: JSON.stringify({
    manifests: [
      {
        digest:
          'sha256:aaaa11111111111111111111111111111111111111111111111111111111aaaa',
        platform: { os: 'linux', architecture: 'amd64' },
      },
      {
        digest:
          'sha256:bbbb22222222222222222222222222222222222222222222222222222222bbbb',
        platform: { os: 'linux', architecture: 'arm64' },
      },
    ],
  }),
};

const NGINX_PLATFORM_MANIFEST: CannedResponse = {
  urlMatch: '/manifests/sha256:aaaa',
  status: 200,
  headers: {
    'content-type': 'application/vnd.docker.distribution.manifest.v2+json',
    'docker-content-digest':
      'sha256:aaaa11111111111111111111111111111111111111111111111111111111aaaa',
  },
  body: JSON.stringify({
    config: {
      digest:
        'sha256:cccc33333333333333333333333333333333333333333333333333333333cccc',
    },
  }),
};

const NGINX_CONFIG_BLOB: CannedResponse = {
  urlMatch: '/blobs/sha256:cccc',
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    config: {
      ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
      Env: ['NGINX_VERSION=1.27', 'PATH=/usr/local/sbin:/usr/local/bin'],
      Cmd: ['nginx', '-g', 'daemon off;'],
      User: '',
      WorkingDir: '/',
      Labels: { maintainer: 'NGINX Docker Maintainers' },
    },
  }),
};

describe('inspectImage — happy path via canned fetch (Docker Hub multi-arch)', () => {
  it('resolves manifest index → platform manifest → config blob and returns ImageInfo', async () => {
    const fetchImpl = makeCannedFetch([
      DOCKER_TOKEN_OK,
      NGINX_MANIFEST_INDEX,
      NGINX_PLATFORM_MANIFEST,
      NGINX_CONFIG_BLOB,
    ]);
    const logger = vi.fn();
    const result = await inspectImage('nginx:1.27', {
      fetch: fetchImpl,
      logger,
    });

    expect(result).not.toBeNull();
    expect(result?.image).toBe('docker.io/library/nginx:1.27');
    expect(result?.digest).toBe(
      'sha256:aaaa11111111111111111111111111111111111111111111111111111111aaaa',
    );
    expect(result?.ports).toEqual(['443/tcp', '80/tcp']);
    expect(result?.env).toEqual({
      NGINX_VERSION: '1.27',
      PATH: '/usr/local/sbin:/usr/local/bin',
    });
    expect(result?.cmd).toEqual(['nginx', '-g', 'daemon off;']);
    expect(result?.labels).toEqual({ maintainer: 'NGINX Docker Maintainers' });
    expect(result?.suggestedTmpfs).toEqual(['/var/cache/nginx', '/var/run']);
    expect(logger).not.toHaveBeenCalled();
  });
});

describe('inspectImage — fail-soft contract (null return + logger)', () => {
  it('returns null on Docker Hub 429 rate-limit', async () => {
    const fetchImpl = makeCannedFetch([
      {
        urlMatch: 'auth.docker.io/token',
        status: 429,
        body: 'too many requests',
      },
    ]);
    const logger = vi.fn();
    const result = await inspectImage('nginx:1.27', {
      fetch: fetchImpl,
      logger,
    });
    expect(result).toBeNull();
    expect(logger).toHaveBeenCalled();
    expect(logger.mock.calls[0]?.[0]).toMatch(/429/);
  });

  it('returns null on private registry 401', async () => {
    const fetchImpl = makeCannedFetch([
      {
        urlMatch: '/manifests/',
        status: 401,
        body: 'unauthorized',
      },
    ]);
    const logger = vi.fn();
    const result = await inspectImage('ghcr.io/private/repo:latest', {
      fetch: fetchImpl,
      logger,
    });
    expect(result).toBeNull();
    expect(logger).toHaveBeenCalled();
    expect(logger.mock.calls[0]?.[0]).toMatch(/401/);
  });

  it('returns null on 404 image-not-found', async () => {
    const fetchImpl = makeCannedFetch([
      DOCKER_TOKEN_OK,
      {
        urlMatch: '/manifests/',
        status: 404,
        body: 'not found',
      },
    ]);
    const logger = vi.fn();
    const result = await inspectImage('nginx:nonexistent', {
      fetch: fetchImpl,
      logger,
    });
    expect(result).toBeNull();
    expect(logger.mock.calls[0]?.[0]).toMatch(/image not found/);
  });

  it('returns null on invalid OCI grammar in image ref (caught pre-fetch)', async () => {
    const fetchImpl = vi.fn();
    const logger = vi.fn();
    const result = await inspectImage('Invalid-Name-Component:tag', {
      fetch: fetchImpl as unknown as typeof fetch,
      logger,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled(); // grammar rejected before any fetch
    expect(logger.mock.calls[0]?.[0]).toMatch(/invalid name component/);
  });

  it('returns null on invalid tag grammar', async () => {
    const logger = vi.fn();
    // Tag with `!` violates OCI_TAG regex (alphanumeric + `._-` only).
    // Note: `nginx:bad/tag` would parse as registry='nginx:bad'+name='tag'
    // (registry heuristic triggers on colon in head); pick a tag with a
    // character that's invalid AFTER the basename strip.
    const result = await inspectImage('nginx:bad!tag', {
      fetch: vi.fn() as unknown as typeof fetch,
      logger,
    });
    expect(result).toBeNull();
    expect(logger.mock.calls[0]?.[0]).toMatch(/invalid tag/);
  });

  it('returns null on invalid digest grammar', async () => {
    const logger = vi.fn();
    const result = await inspectImage('nginx@sha256:not-hex', {
      fetch: vi.fn() as unknown as typeof fetch,
      logger,
    });
    expect(result).toBeNull();
    expect(logger.mock.calls[0]?.[0]).toMatch(/invalid digest/);
  });

  it('returns null on unparseable manifest JSON', async () => {
    const fetchImpl = makeCannedFetch([
      DOCKER_TOKEN_OK,
      {
        urlMatch: '/manifests/',
        status: 200,
        headers: {
          'content-type': 'application/vnd.oci.image.manifest.v1+json',
        },
        body: 'not valid {json',
      },
    ]);
    const logger = vi.fn();
    const result = await inspectImage('nginx:1.27', {
      fetch: fetchImpl,
      logger,
    });
    expect(result).toBeNull();
    expect(logger.mock.calls[0]?.[0]).toMatch(/not valid JSON/);
  });

  it('returns null on body exceeding 10 MiB cap', async () => {
    // Generate 11 MiB of canned body bytes via stream chunks.
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('auth.docker.io/token')) {
        return new Response(JSON.stringify({ token: 't' }), { status: 200 });
      }
      const chunkSize = 1024 * 1024; // 1 MiB
      const chunkCount = 11;
      let emitted = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted >= chunkCount) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunkSize));
          emitted += 1;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'application/vnd.oci.image.manifest.v1+json',
        },
      });
    }) as typeof fetch;
    const logger = vi.fn();
    const result = await inspectImage('nginx:1.27', {
      fetch: fetchImpl,
      logger,
    });
    expect(result).toBeNull();
    expect(logger.mock.calls[0]?.[0]).toMatch(/exceeded .* bytes/);
  });
});

describe('inspectImage — ref parsing', () => {
  it('expands bare "nginx" → "docker.io/library/nginx:latest"', async () => {
    const fetchImpl = makeCannedFetch([
      DOCKER_TOKEN_OK,
      {
        ...NGINX_MANIFEST_INDEX,
        urlMatch: '/manifests/latest',
      },
      NGINX_PLATFORM_MANIFEST,
      NGINX_CONFIG_BLOB,
    ]);
    const result = await inspectImage('nginx', { fetch: fetchImpl });
    expect(result?.image).toBe('docker.io/library/nginx:latest');
  });

  it('handles digest-pinned ref ("name@sha256:...")', async () => {
    const fetchImpl = makeCannedFetch([
      DOCKER_TOKEN_OK,
      {
        ...NGINX_PLATFORM_MANIFEST,
        urlMatch: '/manifests/sha256:dddd',
      },
      {
        ...NGINX_CONFIG_BLOB,
        urlMatch: '/blobs/sha256:cccc',
      },
    ]);
    const result = await inspectImage(
      'nginx@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      { fetch: fetchImpl },
    );
    expect(result?.image).toMatch(/^docker\.io\/library\/nginx@sha256:dddd/);
  });

  it('handles custom registry refs', async () => {
    const fetchImpl = makeCannedFetch([
      {
        urlMatch: 'ghcr.io/v2/owner/repo/manifests/v1.0',
        status: 200,
        headers: {
          'content-type': 'application/vnd.oci.image.manifest.v1+json',
          'docker-content-digest':
            'sha256:eeee55555555555555555555555555555555555555555555555555555555eeee',
        },
        body: JSON.stringify({
          config: {
            digest:
              'sha256:ffff66666666666666666666666666666666666666666666666666666666ffff',
          },
        }),
      },
      {
        urlMatch: 'ghcr.io/v2/owner/repo/blobs/sha256:ffff',
        status: 200,
        body: JSON.stringify({ config: {} }),
      },
    ]);
    const result = await inspectImage('ghcr.io/owner/repo:v1.0', {
      fetch: fetchImpl,
    });
    expect(result?.image).toBe('ghcr.io/owner/repo:v1.0');
  });
});

describe('inspectImage — suggestedTmpfs heuristic', () => {
  it.each<[string, readonly string[]]>([
    ['wordpress:6.5', ['/run/lock', '/var/run/apache2']],
    ['mariadb:11', ['/run/mysqld']],
    ['postgres:16', ['/var/run/postgresql']],
    ['mysql:8', ['/var/run/mysqld']],
    ['nginx:1.27', ['/var/cache/nginx', '/var/run']],
  ])('matches "%s" → %p', async (imageRef, expectedPaths) => {
    const fetchImpl = makeCannedFetch([
      DOCKER_TOKEN_OK,
      {
        urlMatch: '/manifests/',
        status: 200,
        headers: {
          'content-type': 'application/vnd.oci.image.manifest.v1+json',
        },
        body: JSON.stringify({
          config: {
            digest:
              'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          },
        }),
      },
      {
        urlMatch: '/blobs/',
        status: 200,
        body: JSON.stringify({ config: {} }),
      },
    ]);
    const result = await inspectImage(imageRef, { fetch: fetchImpl });
    expect(result?.suggestedTmpfs).toEqual([...expectedPaths]);
  });

  it('returns [] for images with no matching token', async () => {
    const fetchImpl = makeCannedFetch([
      DOCKER_TOKEN_OK,
      {
        urlMatch: '/manifests/',
        status: 200,
        headers: {
          'content-type': 'application/vnd.oci.image.manifest.v1+json',
        },
        body: JSON.stringify({
          config: {
            digest:
              'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          },
        }),
      },
      {
        urlMatch: '/blobs/',
        status: 200,
        body: JSON.stringify({ config: {} }),
      },
    ]);
    const result = await inspectImage('busybox:latest', { fetch: fetchImpl });
    expect(result?.suggestedTmpfs).toEqual([]);
  });
});

describe('inspectImage — default fetch (createGuardedFetch) SSRF rejection', () => {
  it('rejects 127.0.0.1-based image ref via default fetch → null + SSRF log', async () => {
    const logger = vi.fn();
    // Don't pass opts.fetch — exercises createGuardedFetch() default.
    const result = await inspectImage('127.0.0.1:9999/foo/bar:latest', {
      logger,
    });
    expect(result).toBeNull();
    expect(logger).toHaveBeenCalled();
    const reason = logger.mock.calls[0]?.[0] as string;
    expect(reason).toMatch(/(SSRF blocked|loopback)/i);
  }, 15_000);

  it('rejects 169.254.169.254 metadata-target via default fetch', async () => {
    const logger = vi.fn();
    const result = await inspectImage('169.254.169.254:80/foo/bar:latest', {
      logger,
    });
    expect(result).toBeNull();
    expect(logger).toHaveBeenCalled();
    const reason = logger.mock.calls[0]?.[0] as string;
    expect(reason).toMatch(/(SSRF blocked|linkLocal)/i);
  }, 15_000);
});
