#!/usr/bin/env node
import {
  ChainMCPServer,
  type ChainMCPServerOptions,
} from '@manifest-network/manifest-mcp-chain';
import { bootstrap } from './bootstrap.js';

const faucetUrl = process.env.MANIFEST_FAUCET_URL || undefined;

bootstrap({
  cliName: 'manifest-mcp-chain',
  label: 'chain',
  createServer: (opts) =>
    new ChainMCPServer({
      ...opts,
      faucetUrl,
    } as ChainMCPServerOptions).getServer(),
});
