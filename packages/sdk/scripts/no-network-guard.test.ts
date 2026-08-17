import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  __drainBannedFetchCalls,
  BANNED_FETCH_MESSAGE,
} from '../../../tools/vitest/ban-global-fetch.js';

/**
 * The no-network guard is armed, and it bites (ENG-705).
 *
 * `tools/vitest/ban-global-fetch.ts` replaces `globalThis.fetch` with a throwing stub in every
 * test worker, so a mock that fails to intercept surfaces as a named failure instead of a real
 * outbound request. Two things can silently un-do that, and this file checks both:
 *
 *  1. The wiring rots — a package's `vitest.config.ts` loses (or never gains) the `setupFiles`
 *     entry. There is no root vitest config to inherit from, so each package carries its own
 *     line and a new package starts with none.
 *  2. The stub stops throwing.
 *
 * Lives here, beside `cast-guard.test.ts` and `mock-arg-indexing-guard.test.ts`, because it is a
 * repo-wide guard rather than a claim about the SDK. Note the split: check (1) is a source scan
 * covering all nine packages, while (2) can only observe THIS worker — which is the SDK's, and is
 * exactly why (1) has to exist.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Walk up to the monorepo root (the dir holding `.dependency-cruiser.cjs`). */
function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    try {
      statSync(join(dir, '.dependency-cruiser.cjs'));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error(
    'could not locate repo root (.dependency-cruiser.cjs not found walking up)',
  );
}

const ROOT = repoRoot();

/** The workspace roots `npm test` iterates. `e2e/` is deliberately absent — it is not a
 *  workspace member, `npm test` never runs it, and it talks to a live chain on purpose. */
const WORKSPACE_ROOTS = ['packages', 'examples'];

// Every <root>/<name>/vitest.config.ts, by workspace name. (A line comment on purpose: the
// glob form of that path contains `*/`, which would close a block comment early.)
function packageConfigs(): { pkg: string; file: string }[] {
  const out: { pkg: string; file: string }[] = [];
  for (const root of WORKSPACE_ROOTS) {
    const dir = join(ROOT, root);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(dir, entry.name, 'vitest.config.ts');
      try {
        statSync(file);
        out.push({ pkg: entry.name, file });
      } catch {
        // A workspace without a vitest config is caught by check (3) if it runs vitest.
      }
    }
  }
  return out;
}

describe('no-network guard (ENG-705)', () => {
  it('(1) finds a vitest config for every workspace', () => {
    // Vacuity control: a broken walk would make check (2) pass over an empty list.
    const configs = packageConfigs();
    expect(configs.length).toBeGreaterThanOrEqual(10);
    expect(configs.map((c) => c.pkg)).toEqual(
      expect.arrayContaining([
        'agent',
        'agent-core',
        'chain',
        'core',
        'cosmwasm',
        'fred',
        'lease',
        'node',
        'sdk',
        'sdk-acceptance',
      ]),
    );
  });

  it('(2) every package loads the ban as a setupFile', () => {
    const missing: string[] = [];
    for (const { file } of packageConfigs()) {
      const src = readFileSync(file, 'utf8');
      // `setupFiles`, naming this module. Not a strict equality check — a package is free to
      // add its own setup files alongside, so long as the ban is among them.
      const wired =
        src.includes('setupFiles') &&
        src.includes('tools/vitest/ban-global-fetch.ts');
      if (!wired) missing.push(relative(ROOT, file).split(sep).join('/'));
    }
    expect(
      missing,
      'Each package carries its own vitest config — there is no root config to inherit from, so\n' +
        'a new package starts with NO network guard and its tests can silently reach the real\n' +
        "network. Add `setupFiles: ['../../tools/vitest/ban-global-fetch.ts']`. See ENG-705.\n\n" +
        'Missing:\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('(3) every workspace that runs vitest HAS a config to be wired', () => {
    // The only way to opt out silently is a new workspace with a `test` script and no config —
    // checks (1) and (2) would both skip right over it.
    const missing: string[] = [];
    for (const root of WORKSPACE_ROOTS) {
      const rootDir = join(ROOT, root);
      for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(rootDir, entry.name);
        let pkg: { scripts?: Record<string, string> };
        try {
          pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        } catch {
          continue;
        }
        if (!pkg.scripts?.test?.includes('vitest')) continue;
        try {
          statSync(join(dir, 'vitest.config.ts'));
        } catch {
          missing.push(`${root}/${entry.name}`);
        }
      }
    }
    expect(
      missing,
      'These packages run vitest with no config, so they inherit no setup file and their\n' +
        'tests can reach the real network. Add a vitest.config.ts wiring the ban (ENG-705).\n\n' +
        `Missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('(4) the banned global actually throws', () => {
    // A rule never proven to fire is not a guard.
    expect(() => globalThis.fetch('https://example.com')).toThrow(
      BANNED_FETCH_MESSAGE,
    );
    __drainBannedFetchCalls();
  });

  it('(5) a SWALLOWED violation is still reported', async () => {
    // The layer that matters most in this repo: fred's transport catches ANY throw from the
    // injected fetch and re-wraps it as `ProviderApiError{kind:'network'}`. A test asserting
    // that would go green on a banned call if the throw were the only signal.
    try {
      await globalThis.fetch('https://swallowed.example');
    } catch {
      // exactly what the code under test does
    }
    const hits = __drainBannedFetchCalls();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('https://swallowed.example');
  });

  it('(6) vi.stubGlobal remains a working escape hatch, and unstubbing re-arms the ban', () => {
    // The deliberate `?? globalThis.fetch` fallback tests in fred's provider.test.ts depend on
    // this exact sequence. If `unstubAllGlobals` restored the REAL fetch instead of the stub,
    // every test after them in that worker would be unguarded.
    const banned = globalThis.fetch;
    const stub = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    expect(globalThis.fetch).toBe(stub);

    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(banned);
    expect(() => globalThis.fetch('https://example.com')).toThrow(
      BANNED_FETCH_MESSAGE,
    );
    __drainBannedFetchCalls();
  });
});
