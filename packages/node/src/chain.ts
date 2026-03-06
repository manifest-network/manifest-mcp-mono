#!/usr/bin/env node
import { ChainMCPServer } from '@manifest-network/manifest-mcp-chain';
import { bootstrap } from './bootstrap.js';

bootstrap({
  cliName: 'manifest-mcp-chain',
  label: 'chain',
  createServer: (opts) => new ChainMCPServer(opts).getServer(),
});
