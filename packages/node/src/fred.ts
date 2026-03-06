#!/usr/bin/env node
import { FredMCPServer } from '@manifest-network/manifest-mcp-fred';
import { bootstrap } from './bootstrap.js';

bootstrap({
  cliName: 'manifest-mcp-fred',
  label: 'fred',
  createServer: (opts) => new FredMCPServer(opts).getServer(),
});
