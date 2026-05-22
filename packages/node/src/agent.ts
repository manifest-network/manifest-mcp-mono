#!/usr/bin/env node
import { AgentMCPServer } from '@manifest-network/manifest-mcp-agent';
import { bootstrap } from './bootstrap.js';

bootstrap({
  cliName: 'manifest-mcp-agent',
  label: 'agent',
  createServer: (opts) => new AgentMCPServer(opts).getServer(),
});
