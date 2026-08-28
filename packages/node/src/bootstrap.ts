import { existsSync } from 'node:fs';
import {
  createValidatedConfig,
  logger,
  ManifestMCPError,
  MnemonicWalletProvider,
  parseLogLevel,
  sanitizeForLogging,
  type WalletProvider,
} from '@manifest-network/manifest-mcp-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { KeyfileWalletProvider } from './keyfileWallet.js';

/** Thrown after process.exit() to halt control flow when exit is mocked. */
class ExitError extends Error {
  constructor() {
    super();
    this.name = 'ExitError';
  }
}

function exit(code: number): never {
  process.exit(code);
  throw new ExitError();
}

/**
 * Configuration for bootstrapping a CLI entry point.
 */
export interface BootstrapConfig {
  /** CLI binary name shown in usage text (e.g. "manifest-mcp-chain") */
  readonly cliName: string;
  /** Human-readable server label for the startup log (e.g. "chain") */
  readonly label: string;
  /** Factory that creates the MCP server wrapper and its owned resources. */
  readonly createServer: (opts: {
    config: ReturnType<typeof createValidatedConfig>;
    walletProvider: WalletProvider;
  }) => BootstrapServer;
}

/** Resource-owning server surface shared by all CLI package wrappers. */
export interface BootstrapServer {
  getServer(): Server;
  disconnect(): void;
  /** Release the runtime after its already-enqueued broadcast queue drains. */
  disconnectWhenIdle?(): Promise<void>;
}

const SHUTDOWN_GRACE_MS = 30_000;

function handleSubcommand(
  cliName: string,
  label: string,
  subcommand: string,
): Promise<void> {
  if (subcommand === 'keygen') {
    return import('./keygen.js').then(({ runKeygen }) => runKeygen());
  }
  if (subcommand === 'import') {
    return import('./keygen.js').then(({ runImport }) => runImport());
  }
  if (subcommand === 'export') {
    return import('./keygen.js').then(({ runExport }) => runExport());
  }

  console.error(
    `Unknown subcommand: "${subcommand}"\n\n` +
      'Usage:\n' +
      `  ${cliName}              Start the ${label} MCP server\n` +
      `  ${cliName} keygen       Generate a new encrypted keyfile\n` +
      `  ${cliName} import       Import a mnemonic into an encrypted keyfile\n` +
      `  ${cliName} export       Print the keyfile's recovery phrase (asks for the password)\n`,
  );
  exit(1);
}

function resolveWallet(
  env: ReturnType<typeof loadConfig>,
  config: ReturnType<typeof createValidatedConfig>,
  cliName: string,
): WalletProvider {
  if (existsSync(env.keyfilePath)) {
    console.error(`Using encrypted keyfile wallet from ${env.keyfilePath}`);
    return new KeyfileWalletProvider(
      env.keyfilePath,
      env.addressPrefix,
      env.keyPassword,
    );
  }

  if (env.mnemonic) {
    console.error('Using mnemonic wallet from COSMOS_MNEMONIC');
    return new MnemonicWalletProvider(config, env.mnemonic);
  }

  console.error(
    'No wallet found. Either:\n' +
      `  1. Run "${cliName} keygen" to generate an encrypted keyfile at ${env.keyfilePath}\n` +
      '  2. Set the COSMOS_MNEMONIC environment variable',
  );
  exit(1);
}

function cleanupWarning(resource: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn(
    `Failed to disconnect ${resource}: ${sanitizeForLogging(message) as string}`,
  );
}

async function closeResources(
  server: Server | undefined,
  runtime: BootstrapServer | undefined,
  walletProvider: WalletProvider | undefined,
): Promise<void> {
  // Close first so the MCP SDK aborts request-scoped work and stops accepting
  // calls. The SDK deliberately suppresses the response for an aborted request;
  // `disconnectWhenIdle` below is therefore a broadcast drain, not a promise
  // that every handler response reaches the host. This ordering prioritizes the
  // irreversible boundary: an already-enqueued transaction keeps its RPC
  // client until it settles instead of being severed merely to preserve stdio.
  try {
    await server?.close();
  } catch (error) {
    cleanupWarning('MCP transport', error);
  }

  try {
    if (runtime?.disconnectWhenIdle) {
      await runtime.disconnectWhenIdle();
    } else {
      runtime?.disconnect();
    }
  } catch (error) {
    cleanupWarning('Cosmos client manager', error);
  }

  try {
    await walletProvider?.disconnect?.();
  } catch (error) {
    cleanupWarning('wallet', error);
  }
}

async function closeResourcesWithinDeadline(
  server: Server,
  runtime: BootstrapServer,
  walletProvider: WalletProvider,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        `Graceful shutdown exceeded ${SHUTDOWN_GRACE_MS}ms; forcing process exit`,
      );
      resolve();
    }, SHUTDOWN_GRACE_MS);
  });

  await Promise.race([
    closeResources(server, runtime, walletProvider),
    deadline,
  ]);
  if (timer) clearTimeout(timer);
}

/** Install one idempotent shutdown path for transport, clients, and wallet. */
function installShutdownHandlers(
  server: Server,
  runtime: BootstrapServer,
  walletProvider: WalletProvider,
): void {
  let shuttingDown = false;
  let forcedExit = false;
  let shutdownPromise = Promise.resolve();
  let shutdown = (): Promise<void> => shutdownPromise;
  const previousOnClose = server.onclose;

  const onInputClosed = (): void => {
    void shutdown();
  };
  const onSigint = (): void => {
    if (shuttingDown) {
      forcedExit = true;
      process.exit(130);
      return;
    }
    void shutdown().finally(() => {
      if (!forcedExit) process.exit(130);
    });
  };
  const onSigterm = (): void => {
    if (shuttingDown) {
      forcedExit = true;
      process.exit(143);
      return;
    }
    void shutdown().finally(() => {
      if (!forcedExit) process.exit(143);
    });
  };
  const onServerClose = (): void => {
    try {
      previousOnClose?.();
    } finally {
      void shutdown();
    }
  };

  const removeNonSignalHandlers = (): void => {
    process.stdin.off('end', onInputClosed);
    process.stdin.off('close', onInputClosed);
    if (server.onclose === onServerClose) {
      server.onclose = previousOnClose;
    }
  };

  const removeSignalHandlers = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };

  shutdown = (): Promise<void> => {
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;
    // Stop duplicate EOF/transport-close entry, but keep signal handlers live:
    // a second Ctrl-C/SIGTERM is the explicit immediate-exit escape hatch.
    removeNonSignalHandlers();
    shutdownPromise = closeResourcesWithinDeadline(
      server,
      runtime,
      walletProvider,
    ).finally(removeSignalHandlers);
    return shutdownPromise;
  };

  server.onclose = onServerClose;
  process.stdin.once('end', onInputClosed);
  process.stdin.once('close', onInputClosed);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  // Cover EOF that raced with handler installation while connect() awaited.
  if (process.stdin.readableEnded || process.stdin.destroyed) {
    void shutdown();
  }
}

/**
 * Shared bootstrap for all five CLI entry points (chain, lease, fred,
 * cosmwasm, agent).
 *
 * Handles subcommand dispatch, config loading, wallet resolution,
 * transport setup, and top-level error handling.
 */
export function bootstrap(cfg: BootstrapConfig): void {
  async function main(): Promise<void> {
    logger.setLevel(parseLogLevel(process.env.LOG_LEVEL));

    const subcommand = process.argv[2];
    if (subcommand) {
      await handleSubcommand(cfg.cliName, cfg.label, subcommand);
      return;
    }

    const env = loadConfig();

    const config = createValidatedConfig({
      chainId: env.chainId,
      rpcUrl: env.rpcUrl,
      gasPrice: env.gasPrice,
      restUrl: env.restUrl,
      addressPrefix: env.addressPrefix,
      gasMultiplier: env.gasMultiplier,
      maxGas: env.maxGas,
    });

    const walletProvider = resolveWallet(env, config, cfg.cliName);
    let runtime: BootstrapServer | undefined;
    let server: Server | undefined;

    try {
      if (walletProvider.connect) {
        await walletProvider.connect();
      }

      runtime = cfg.createServer({ config, walletProvider });
      server = runtime.getServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
      installShutdownHandlers(server, runtime, walletProvider);

      console.error(`Manifest MCP ${cfg.label} server running on stdio`);
    } catch (error) {
      await closeResources(server, runtime, walletProvider);
      throw error;
    }
  }

  main().catch((error) => {
    if (error instanceof ExitError) return;
    if (error instanceof ManifestMCPError) {
      console.error(
        `Fatal error [${error.code}]: ${sanitizeForLogging(error.message) as string}`,
      );
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Fatal error: ${sanitizeForLogging(msg) as string}`);
    }
    process.exit(1);
  });
}
