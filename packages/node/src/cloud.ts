#!/usr/bin/env node
import { CloudMCPServer } from '@manifest-network/manifest-mcp-cloud';
import { bootstrap } from './bootstrap.js';

bootstrap({
  cliName: 'manifest-mcp-cloud',
  label: 'cloud',
  createServer: (opts) => new CloudMCPServer(opts).getServer(),
});
