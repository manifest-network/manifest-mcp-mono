#!/usr/bin/env node
import { LeaseMCPServer } from '@manifest-network/manifest-mcp-lease';
import { bootstrap } from './bootstrap.js';

bootstrap({
  cliName: 'manifest-mcp-lease',
  label: 'lease',
  createServer: (opts) => new LeaseMCPServer(opts).getServer(),
});
