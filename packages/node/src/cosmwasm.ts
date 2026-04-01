#!/usr/bin/env node
import { CosmwasmMCPServer } from '@manifest-network/manifest-mcp-cosmwasm';
import { bootstrap } from './bootstrap.js';

bootstrap({
  cliName: 'manifest-mcp-cosmwasm',
  label: 'cosmwasm',
  createServer: (opts) => {
    const converterAddress =
      process.env.MANIFEST_CONVERTER_ADDRESS?.trim();
    if (!converterAddress) {
      process.stderr.write(
        'Error: MANIFEST_CONVERTER_ADDRESS environment variable is required.\n' +
          'Set it to the bech32 address of the MFX-to-PWR converter contract.\n',
      );
      process.exit(1);
    }
    return new CosmwasmMCPServer({ ...opts, converterAddress }).getServer();
  },
});
