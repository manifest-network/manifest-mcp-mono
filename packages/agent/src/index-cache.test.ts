// Phase 2 (finding #12) regression test — the wrapper's `getRuntime`
// / `getDenomMap` slots must clear on rejection so a transient failure
// (dynamic-import / fetchFn construction / chain-data file read) does
// not poison every subsequent tool call until process restart.
//
// Lives in its own file so the `vi.mock('./runtime.js', ...)` hoist
// is scoped — the main `server.test.ts` exercises the happy path
// with the real `buildRuntime`.

import type { AgentCoreRuntime } from '@manifest-network/manifest-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` defers the mock-target's creation alongside the
// hoisted `vi.mock` call — without it, the `const` initializer races
// the hoist and produces a TDZ ReferenceError.
const { buildRuntimeMock } = vi.hoisted(() => ({
  buildRuntimeMock: vi.fn(),
}));

vi.mock('./runtime.js', () => ({
  buildRuntime: buildRuntimeMock,
}));

vi.mock('@manifest-network/manifest-mcp-core', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@manifest-network/manifest-mcp-core')
    >();
  return {
    ...actual,
    CosmosClientManager: {
      getInstance: vi.fn().mockReturnValue({
        disconnect: vi.fn(),
        getQueryClient: vi.fn().mockResolvedValue({}),
        getSigningClient: vi.fn().mockResolvedValue({}),
        getAddress: vi.fn().mockResolvedValue('manifest1abc'),
        getConfig: vi.fn().mockReturnValue({ chainId: 'test-chain' }),
        acquireRateLimit: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

import {
  makeMockConfig,
  makeMockWallet,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { AgentMCPServer, type AgentOrchestrators } from './index.js';

let activeTransports: InMemoryTransport[] = [];

beforeEach(() => {
  buildRuntimeMock.mockReset();
  activeTransports = [];
});

afterEach(async () => {
  for (const t of activeTransports) {
    await t.close();
  }
  activeTransports = [];
});

function makeServer(
  orchestrators?: Partial<AgentOrchestrators>,
): AgentMCPServer {
  return new AgentMCPServer({
    config: makeMockConfig(),
    walletProvider: makeMockWallet({ signArbitrary: true }),
    ...(orchestrators ? { orchestrators } : {}),
  });
}

async function invokeLookup(server: AgentMCPServer): Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  activeTransports.push(clientTransport, serverTransport);
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await server.getServer().connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.callTool({
      name: 'lookup_custom_domain_orchestrated',
      arguments: { fqdn: 'app.example.com' },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
  } finally {
    await client.close().catch(() => {});
  }
}

describe('getRuntime cache clears on rejection (finding #12)', () => {
  it('first call rejects → cache cleared → second call rebuilds and succeeds', async () => {
    const runtime: AgentCoreRuntime = {
      clientManager: {} as unknown as AgentCoreRuntime['clientManager'],
    };
    // First call: reject; second call: resolve.
    buildRuntimeMock.mockRejectedValueOnce(
      new Error('transient: guarded-fetch dynamic import failed'),
    );
    buildRuntimeMock.mockResolvedValueOnce(runtime);

    const fakeManageDomain: AgentOrchestrators['manageDomain'] = (async () => ({
      action: 'lookup',
      fqdn: 'app.example.com',
      lease: { leaseUuid: 'lease-1' },
    })) as unknown as AgentOrchestrators['manageDomain'];

    const server = makeServer({ manageDomain: fakeManageDomain });

    // First call surfaces the buildRuntime rejection as a structured error.
    const r1 = await invokeLookup(server);
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toMatch(/transient|guarded-fetch/);

    // Second call: buildRuntime resolves. If the cache HAD latched the
    // rejection, this would also fail with the same error. The
    // identity-guarded `.catch` in `getRuntime` cleared the slot — so
    // `buildRuntime` is called again, succeeds, and the tool returns.
    const r2 = await invokeLookup(server);
    expect(r2.isError).toBeUndefined();

    // buildRuntime was called exactly twice (initial + retry).
    expect(buildRuntimeMock).toHaveBeenCalledTimes(2);
  });

  it('successful build is cached — buildRuntime called once across N calls', async () => {
    const runtime: AgentCoreRuntime = {
      clientManager: {} as unknown as AgentCoreRuntime['clientManager'],
    };
    buildRuntimeMock.mockResolvedValue(runtime);

    const fakeManageDomain: AgentOrchestrators['manageDomain'] = (async () => ({
      action: 'lookup',
      fqdn: 'app.example.com',
      lease: { leaseUuid: 'lease-1' },
    })) as unknown as AgentOrchestrators['manageDomain'];

    const server = makeServer({ manageDomain: fakeManageDomain });

    for (let i = 0; i < 3; i++) {
      const r = await invokeLookup(server);
      expect(r.isError).toBeUndefined();
    }
    // Resolved-promise cache stays put — buildRuntime called exactly once.
    expect(buildRuntimeMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 2 (finding #5) — `MANIFEST_AGENT_FETCH_GUARDED` default is ON.
//
// `env.test.ts` proves `parseBooleanEnv(undefined, true, ...)` returns
// `true`; that's necessary but NOT sufficient. The regression we care
// about is that the call site at `index.ts` passes `true` as the
// `defaultValue` — flipping that one literal to `false` would silently
// regress the SSRF guard while leaving every `parseBooleanEnv` unit
// test green. Pin the call-site default by observing the
// `fetchGuarded` argument `buildRuntime` is invoked with.
// ─────────────────────────────────────────────────────────────────────
describe('AgentMCPServer fetchGuarded default (finding #5)', () => {
  const ENV = 'MANIFEST_AGENT_FETCH_GUARDED';
  let restore: string | undefined;
  beforeEach(() => {
    restore = process.env[ENV];
  });
  afterEach(() => {
    if (restore === undefined) {
      delete process.env[ENV];
    } else {
      process.env[ENV] = restore;
    }
  });

  it('unset env → buildRuntime invoked with fetchGuarded:true (default ON)', async () => {
    delete process.env[ENV];
    const runtime: AgentCoreRuntime = {
      clientManager: {} as unknown as AgentCoreRuntime['clientManager'],
    };
    buildRuntimeMock.mockResolvedValue(runtime);

    const fakeManageDomain: AgentOrchestrators['manageDomain'] = (async () => ({
      action: 'lookup',
      fqdn: 'app.example.com',
      lease: { leaseUuid: 'lease-1' },
    })) as unknown as AgentOrchestrators['manageDomain'];

    const server = makeServer({ manageDomain: fakeManageDomain });
    const r = await invokeLookup(server);
    expect(r.isError).toBeUndefined();
    expect(buildRuntimeMock).toHaveBeenCalledTimes(1);
    const args = buildRuntimeMock.mock.calls[0][0] as { fetchGuarded: boolean };
    expect(args.fetchGuarded).toBe(true);
  });

  it("env='0' → buildRuntime invoked with fetchGuarded:false (explicit opt-out)", async () => {
    process.env[ENV] = '0';
    const runtime: AgentCoreRuntime = {
      clientManager: {} as unknown as AgentCoreRuntime['clientManager'],
    };
    buildRuntimeMock.mockResolvedValue(runtime);

    const fakeManageDomain: AgentOrchestrators['manageDomain'] = (async () => ({
      action: 'lookup',
      fqdn: 'app.example.com',
      lease: { leaseUuid: 'lease-1' },
    })) as unknown as AgentOrchestrators['manageDomain'];

    const server = makeServer({ manageDomain: fakeManageDomain });
    const r = await invokeLookup(server);
    expect(r.isError).toBeUndefined();
    const args = buildRuntimeMock.mock.calls[0][0] as { fetchGuarded: boolean };
    expect(args.fetchGuarded).toBe(false);
  });
});
