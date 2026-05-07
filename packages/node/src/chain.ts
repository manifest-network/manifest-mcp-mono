#!/usr/bin/env node
import { ChainMCPServer } from '@manifest-network/manifest-mcp-chain';
import { validateEndpointUrl } from '@manifest-network/manifest-mcp-core';
import { bootstrap } from './bootstrap.js';

const rawFaucetUrl = process.env.MANIFEST_FAUCET_URL?.trim() || undefined;
let faucetUrl: string | undefined;
if (rawFaucetUrl) {
  const check = validateEndpointUrl(rawFaucetUrl, 'MANIFEST_FAUCET_URL');
  if (!check.valid) {
    console.error(`Invalid MANIFEST_FAUCET_URL: ${check.reason}`);
    process.exit(1);
  }
  faucetUrl = rawFaucetUrl;
}

bootstrap({
  cliName: 'manifest-mcp-chain',
  label: 'chain',
  createServer: (opts) =>
    new ChainMCPServer({
      ...opts,
      faucetUrl,
    }).getServer(),
});
