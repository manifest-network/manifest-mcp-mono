#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ManifestMCPServer,
  MnemonicWalletProvider,
  createValidatedConfig,
} from '@manifest-network/manifest-mcp-core';
import { loadConfig } from './config.js';

async function main() {
  const env = loadConfig();

  const config = createValidatedConfig({
    chainId: env.chainId,
    rpcUrl: env.rpcUrl,
    gasPrice: env.gasPrice,
    addressPrefix: env.addressPrefix,
  });

  const walletProvider = new MnemonicWalletProvider(config, env.mnemonic);
  await walletProvider.connect();

  const mcpServer = new ManifestMCPServer({ config, walletProvider });
  const transport = new StdioServerTransport();
  await mcpServer.getServer().connect(transport);

  console.error('Manifest MCP node server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
