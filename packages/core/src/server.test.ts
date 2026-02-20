import { describe, it, expect, vi } from 'vitest';

// Mock CosmosClientManager before importing ManifestMCPServer
vi.mock('./client.js', () => ({
  CosmosClientManager: {
    getInstance: vi.fn().mockReturnValue({
      disconnect: vi.fn(),
    }),
  },
}));

import { ManifestMCPServer } from './index.js';
import type { WalletProvider, ManifestMCPConfig } from './types.js';
import type { AppRegistry } from './registry.js';

function makeMockConfig(): ManifestMCPConfig {
  return {
    chainId: 'test-chain',
    rpcUrl: 'https://rpc.example.com',
    gasPrice: '1.0umfx',
    addressPrefix: 'manifest',
  };
}

function makeMockWallet(): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('manifest1abc'),
    getSigner: vi.fn().mockResolvedValue({}),
  };
}

function makeMockAppRegistry(): AppRegistry {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

const BASE_TOOL_NAMES = [
  'get_account_info',
  'cosmos_query',
  'cosmos_tx',
  'list_modules',
  'list_module_subcommands',
  'browse_catalog',
  'get_balance',
];

const APP_TOOL_NAMES = [
  'list_apps',
  'app_status',
  'get_logs',
];

describe('ManifestMCPServer', () => {
  describe('getTools', () => {
    it('should return 7 base tools without appRegistry', () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const tools = server.getTools();
      expect(tools).toHaveLength(7);
      expect(tools.map(t => t.name)).toEqual(BASE_TOOL_NAMES);
    });

    it('should return 10 tools with appRegistry', () => {
      const server = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        appRegistry: makeMockAppRegistry(),
      });
      const tools = server.getTools();
      expect(tools).toHaveLength(10);
      expect(tools.map(t => t.name)).toEqual([...BASE_TOOL_NAMES, ...APP_TOOL_NAMES]);
    });

    it('should have correct tool names in each set', () => {
      const serverNoApps = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
      });
      const serverWithApps = new ManifestMCPServer({
        config: makeMockConfig(),
        walletProvider: makeMockWallet(),
        appRegistry: makeMockAppRegistry(),
      });

      const baseNames = new Set(serverNoApps.getTools().map(t => t.name));
      const allNames = new Set(serverWithApps.getTools().map(t => t.name));

      // All base tools present in both
      for (const name of BASE_TOOL_NAMES) {
        expect(baseNames.has(name)).toBe(true);
        expect(allNames.has(name)).toBe(true);
      }

      // App tools only in the app-registry server
      for (const name of APP_TOOL_NAMES) {
        expect(baseNames.has(name)).toBe(false);
        expect(allNames.has(name)).toBe(true);
      }
    });
  });
});
