import { afterEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = (async () =>
  new Response('')) as unknown as typeof globalThis.fetch;

vi.mock('@manifest-network/manifest-mcp-core/guarded-fetch', () => ({
  createGuardedFetch: vi.fn(() => SENTINEL),
}));
vi.mock('./client.js', () => ({
  createFredClient: vi.fn(async (opts: { fetch?: unknown }) => ({
    __opts: opts,
  })),
}));

import { createGuardedFetch } from '@manifest-network/manifest-mcp-core/guarded-fetch';
import { createFredClient } from './client.js';
import { createFredClientNode } from './node.js';

const baseOpts = { config: {} as never, walletProvider: {} as never };

afterEach(() => vi.clearAllMocks());

describe('createFredClientNode', () => {
  it('injects the SSRF-guarded fetch when none is provided', async () => {
    const r = (await createFredClientNode(baseOpts)) as unknown as {
      __opts: { fetch: unknown };
    };
    expect(createGuardedFetch).toHaveBeenCalledTimes(1);
    expect(r.__opts.fetch).toBe(SENTINEL);
  });

  it('passes through an injected fetch and never constructs the guard (?? short-circuit)', async () => {
    const mine = (async () =>
      new Response('')) as unknown as typeof globalThis.fetch;
    const r = (await createFredClientNode({
      ...baseOpts,
      fetch: mine,
    })) as unknown as {
      __opts: { fetch: unknown };
    };
    expect(createGuardedFetch).not.toHaveBeenCalled();
    expect(r.__opts.fetch).toBe(mine);
    expect(createFredClient).toHaveBeenCalledOnce();
  });
});
