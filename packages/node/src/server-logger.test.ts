import { AgentMCPServer } from '@manifest-network/manifest-mcp-agent';
import { ChainMCPServer } from '@manifest-network/manifest-mcp-chain';
import {
  CosmosClientManager,
  logger,
  type ManifestMCPServerOptions,
} from '@manifest-network/manifest-mcp-core';
import {
  makeInclusionTimeoutFixture,
  makeMockConfig,
} from '@manifest-network/manifest-mcp-core/__test-utils__/mocks.js';
import { CosmwasmMCPServer } from '@manifest-network/manifest-mcp-cosmwasm';
import { FredMCPServer } from '@manifest-network/manifest-mcp-fred/server';
import { LeaseMCPServer } from '@manifest-network/manifest-mcp-lease';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ServerRuntime {
  getClientManager(): CosmosClientManager;
  disconnectWhenIdle(): Promise<void>;
}

const SERVERS = [
  { name: 'chain', create: (options) => new ChainMCPServer(options) },
  { name: 'lease', create: (options) => new LeaseMCPServer(options) },
  { name: 'fred', create: (options) => new FredMCPServer(options) },
  {
    name: 'cosmwasm',
    create: (options) =>
      new CosmwasmMCPServer({
        ...options,
        converterAddress: 'manifest1converter',
      }),
  },
  { name: 'agent', create: (options) => new AgentMCPServer(options) },
] satisfies ReadonlyArray<{
  name: string;
  create(options: ManifestMCPServerOptions): ServerRuntime;
}>;

let originalLevel: ReturnType<typeof logger.getLevel>;
let restoreConnection: (() => void) | undefined;
let server: ServerRuntime | undefined;

beforeEach(() => {
  originalLevel = logger.getLevel();
  vi.stubEnv('MANIFEST_FRED_FETCH_GUARDED', '1');
  vi.stubEnv('MANIFEST_AGENT_FETCH_GUARDED', '1');
});

afterEach(async () => {
  try {
    await server?.disconnectWhenIdle();
  } finally {
    server = undefined;
    CosmosClientManager.clearInstances();
    restoreConnection?.();
    restoreConnection = undefined;
    logger.setLevel(originalLevel);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe.each(SERVERS)('$name server manager diagnostics', ({ create }) => {
  it.each(['warn', 'silent'] as const)(
    'routes the real guard warning through the shared logger at level %s',
    async (level) => {
      const fixture = await makeInclusionTimeoutFixture();
      // Use the fixture's real signing class without adding a transitive package
      // import to node. Replace only the connection: no socket or signing occurs.
      const signingClass = fixture.client.constructor;
      const connection = Object.getOwnPropertyDescriptor(
        signingClass,
        'connectWithSigner',
      );
      if (!connection || typeof connection.value !== 'function') {
        throw new Error('Fixture must expose the native signing connection');
      }
      const connect = vi.fn(async () => fixture.client);
      Object.defineProperty(signingClass, 'connectWithSigner', {
        ...connection,
        value: connect,
      });
      restoreConnection = () =>
        Object.defineProperty(signingClass, 'connectWithSigner', connection);

      // A method override is a real unsupported-guard condition. Keep the real
      // manager initialization and its warning instead of mocking setLogger.
      const broadcast = vi.spyOn(fixture.client, 'broadcastTx');
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.setLevel(level);
      server = create({
        config: makeMockConfig({ chainId: fixture.chainId }),
        walletProvider: {
          getAddress: async () => fixture.sender,
          getSigner: async () => fixture.signer,
        },
      });

      const manager = server.getClientManager();
      await expect(manager.getSigningClient()).resolves.toBe(fixture.client);
      await expect(manager.getSigningClient()).resolves.toBe(fixture.client);

      if (level === 'warn') {
        expect(stderr).toHaveBeenCalledExactlyOnceWith(
          '[WARN]',
          'Broadcast failure guard could not be installed: signing client broadcast methods differ from the supported native implementation. ' +
            'Failures after submission may omit sent and transactionHash diagnostics.',
        );
      } else {
        expect(stderr).not.toHaveBeenCalled();
      }
      expect(stdout).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledOnce();
      expect(fixture.comet.status).toHaveBeenCalledOnce();
      expect(broadcast).not.toHaveBeenCalled();
      expect(fixture.sign).not.toHaveBeenCalled();
      expect(fixture.comet.broadcastTxSync).not.toHaveBeenCalled();
    },
  );
});
