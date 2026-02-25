#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ManifestMCPServer,
  ManifestMCPError,
  MnemonicWalletProvider,
  InMemoryAppRegistry,
  createValidatedConfig,
  type WalletProvider,
} from '@manifest-network/manifest-mcp-core';
import { loadConfig } from './config.js';
import { KeyfileWalletProvider } from './keyfileWallet.js';
import { Web3AuthWalletProvider, loadSession } from './web3auth/index.js';

async function handleSubcommand(subcommand: string): Promise<void> {
  if (subcommand === 'keygen') {
    const { runKeygen } = await import('./keygen.js');
    await runKeygen();
    return;
  }
  if (subcommand === 'import') {
    const { runImport } = await import('./keygen.js');
    await runImport();
    return;
  }
  if (subcommand === 'login') {
    const { runLogin } = await import('./login.js');
    await runLogin();
    return;
  }
  if (subcommand === 'logout') {
    const { runLogout } = await import('./logout.js');
    await runLogout();
    return;
  }
  console.error(
    `Unknown subcommand: "${subcommand}"\n\n` +
    'Usage:\n' +
    '  manifest-mcp-node              Start the MCP server\n' +
    '  manifest-mcp-node keygen       Generate a new encrypted keyfile\n' +
    '  manifest-mcp-node import       Import a mnemonic into an encrypted keyfile\n' +
    '  manifest-mcp-node login        Authenticate via OAuth and cache a Web3Auth session\n' +
    '  manifest-mcp-node logout       Remove the cached Web3Auth session\n'
  );
  process.exit(1);
}

async function main() {
  const subcommand = process.argv[2];
  if (subcommand) {
    await handleSubcommand(subcommand);
    return;
  }

  const env = loadConfig();

  const config = createValidatedConfig({
    chainId: env.chainId,
    rpcUrl: env.rpcUrl,
    gasPrice: env.gasPrice,
    addressPrefix: env.addressPrefix,
  });

  let walletProvider: WalletProvider;

  if (existsSync(env.keyfilePath)) {
    console.error(`Using encrypted keyfile wallet from ${env.keyfilePath}`);
    walletProvider = new KeyfileWalletProvider(
      env.keyfilePath,
      env.addressPrefix,
      env.keyPassword,
    );
  } else {
    const session = loadSession();
    if (session) {
      console.error(`Using Web3Auth session wallet (${session.verifierId})`);
      walletProvider = new Web3AuthWalletProvider(session.privateKeyHex, env.addressPrefix);
    } else if (env.mnemonic) {
      console.error('Using mnemonic wallet from COSMOS_MNEMONIC');
      walletProvider = new MnemonicWalletProvider(config, env.mnemonic);
    } else {
      console.error(
        'No wallet found. Either:\n' +
        `  1. Run "manifest-mcp-node keygen" to generate an encrypted keyfile at ${env.keyfilePath}\n` +
        '  2. Run "manifest-mcp-node login" to authenticate via OAuth (Web3Auth)\n' +
        '  3. Set the COSMOS_MNEMONIC environment variable'
      );
      process.exit(1);
    }
  }

  if (walletProvider.connect) {
    await walletProvider.connect();
  }

  const appRegistry = new InMemoryAppRegistry();
  const mcpServer = new ManifestMCPServer({ config, walletProvider, appRegistry });
  const transport = new StdioServerTransport();
  await mcpServer.getServer().connect(transport);

  console.error('Manifest MCP node server running on stdio');
}

main().catch((error) => {
  if (error instanceof ManifestMCPError) {
    console.error(`Fatal error [${error.code}]: ${error.message}`);
  } else {
    console.error('Fatal error:', error);
  }
  process.exit(1);
});
