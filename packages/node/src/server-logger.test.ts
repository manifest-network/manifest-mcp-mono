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
      // import to node. Redirect the connection to its mocked signing/Comet wire;
      // the broadcastTx spy below separately forces an unsupported method identity.
      // Initialization does not invoke signing or broadcast, and opens no socket.
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
      const warn = vi.spyOn(logger, 'warn');
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
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

      // Both levels must reach the real shared logger through this manager.
      // Silence is a level decision, not proof by absence from an unbound sink.
      const warning =
        'Broadcast failure guard could not be installed: signing client broadcast methods differ from the supported native implementation. ' +
        'Failures after submission may omit sent and transactionHash diagnostics.';
      expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
      if (level === 'warn') {
        expect(stderr).toHaveBeenCalledExactlyOnceWith('[WARN]', warning);
      } else {
        expect(stderr).not.toHaveBeenCalled();
      }
      expect(consoleLog).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledOnce();
      expect(fixture.comet.status).toHaveBeenCalledOnce();
      expect(broadcast).not.toHaveBeenCalled();
      expect(fixture.sign).not.toHaveBeenCalled();
      expect(fixture.comet.broadcastTxSync).not.toHaveBeenCalled();
    },
  );
});
