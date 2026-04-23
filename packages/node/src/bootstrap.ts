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
  /** Factory that creates the MCP server and returns its underlying Server */
  readonly createServer: (opts: {
    config: ReturnType<typeof createValidatedConfig>;
    walletProvider: WalletProvider;
  }) => Server;
}

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

  console.error(
    `Unknown subcommand: "${subcommand}"\n\n` +
      'Usage:\n' +
      `  ${cliName}              Start the ${label} MCP server\n` +
      `  ${cliName} keygen       Generate a new encrypted keyfile\n` +
      `  ${cliName} import       Import a mnemonic into an encrypted keyfile\n`,
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

/**
 * Shared bootstrap for all three CLI entry points (chain, lease, fred).
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
    });

    const walletProvider = resolveWallet(env, config, cfg.cliName);

    if (walletProvider.connect) {
      await walletProvider.connect();
    }

    const server = cfg.createServer({ config, walletProvider });
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`Manifest MCP ${cfg.label} server running on stdio`);
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
