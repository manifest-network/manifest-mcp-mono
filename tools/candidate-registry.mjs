import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// npm's registry metadata must describe the bytes it will install. Read the
// manifest directly from the npm-generated tarball instead of trusting a
// separately edited candidate JSON file. No archive paths are extracted.
function packedManifest(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tar.toString('utf8', offset, offset + 100).split('\0')[0];
    if (!name) break;
    const size = Number.parseInt(
      tar
        .toString('ascii', offset + 124, offset + 136)
        .trim()
        .replaceAll('\0', ''),
      8,
    );
    assert.ok(
      Number.isSafeInteger(size) &&
        size >= 0 &&
        offset + 512 + size <= tar.length,
      'Invalid npm tarball entry size',
    );
    if (name === 'package/package.json') {
      return JSON.parse(
        tar.toString('utf8', offset + 512, offset + 512 + size),
      );
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Candidate tarball does not contain package/package.json');
}

/**
 * Stage immutable tarballs without publishing or changing dependency ranges.
 * A child process keeps serving while callers run synchronous npm commands.
 * With no upstream, unknown packages fail rather than accessing the network.
 */
export async function startCandidateRegistry(candidates, { upstream } = {}) {
  if (upstream) {
    assert.equal(new URL(upstream).origin, 'https://registry.npmjs.org');
  }
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = fork(fileURLToPath(import.meta.url), ['--worker'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Candidate registry startup timed out')),
        10_000,
      );
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Candidate registry exited ${code}: ${stderr}`));
      });
    });
    child.send({ candidates, upstream });
    const { url } = await ready;
    assert.ok(url, stderr);
    return {
      url,
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

if (process.argv[2] === '--worker') {
  process.once('message', ({ candidates, upstream }) => {
    const artifacts = candidates.map(
      ({ manifest: expected, path, tag }, index) => {
        const bytes = readFileSync(path);
        const manifest = packedManifest(bytes);
        if (expected)
          assert.deepEqual(
            manifest,
            expected,
            'Candidate metadata differs from packed package.json',
          );
        assert.ok(
          manifest.name && manifest.version,
          'Candidate manifest requires name and version',
        );
        return {
          manifest,
          tag,
          bytes,
          pathname: `/tarballs/${index}.tgz`,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        };
      },
    );
    assert.equal(
      new Set(
        artifacts.map(({ manifest }) => `${manifest.name}@${manifest.version}`),
      ).size,
      artifacts.length,
      'Duplicate candidate versions',
    );
    let endpoint;
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, endpoint);
        const pathname = decodeURIComponent(url.pathname);
        const artifact = artifacts.find((entry) => entry.pathname === pathname);
        if (request.method === 'GET' && artifact) {
          response.setHeader('content-type', 'application/octet-stream');
          response.end(artifact.bytes);
          return;
        }
        const versions = artifacts.filter(
          ({ manifest }) =>
            pathname === `/${manifest.name}` ||
            pathname === `/${manifest.name}/${manifest.version}`,
        );
        if (request.method === 'GET' && versions.length) {
          const name = versions[0].manifest.name;
          let metadata = { name, versions: {}, 'dist-tags': {} };
          if (upstream) {
            const existing = await fetch(
              `${upstream}/${encodeURIComponent(name)}`,
              { signal: AbortSignal.timeout(30_000) },
            );
            if (existing.ok) metadata = await existing.json();
            else
              assert.equal(
                existing.status,
                404,
                `Registry lookup failed: ${name}`,
              );
          }
          for (const {
            manifest,
            pathname: tarballPath,
            integrity,
            tag,
          } of versions) {
            const published = metadata.versions[manifest.version];
            assert.ok(
              !published || published.dist?.integrity === integrity,
              `Cannot replace published candidate: ${name}@${manifest.version}`,
            );
            metadata.versions[manifest.version] = {
              ...manifest,
              dist: { tarball: `${endpoint}${tarballPath}`, integrity },
            };
            if (tag) metadata['dist-tags'][tag] = manifest.version;
          }
          // Only explicitly staged tags change; merely adding a candidate does
          // not make it latest or modify the consumer's dependency ranges.
          const version = versions.find(
            ({ manifest }) => pathname === `/${name}/${manifest.version}`,
          );
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify(
              version ? metadata.versions[version.manifest.version] : metadata,
            ),
          );
          return;
        }
        const audit =
          request.method === 'POST' &&
          [
            '/-/npm/v1/security/advisories/bulk',
            '/-/npm/v1/security/audits/quick',
          ].includes(pathname);
        if (!upstream || (request.method !== 'GET' && !audit)) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'No matching staged package' }));
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        // Do not forward npm credentials or permit publication through this server.
        const result = await fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers: {
            accept: request.headers.accept ?? 'application/json',
            ...(request.headers['content-type']
              ? { 'content-type': request.headers['content-type'] }
              : {}),
            ...(request.headers['content-encoding']
              ? { 'content-encoding': request.headers['content-encoding'] }
              : {}),
          },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
        response.writeHead(result.status, {
          'content-type':
            result.headers.get('content-type') ?? 'application/octet-stream',
        });
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch (error) {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${server.address().port}`;
      process.send({ url: endpoint });
    });
    process.once('disconnect', () => process.exit(0));
  });
}
