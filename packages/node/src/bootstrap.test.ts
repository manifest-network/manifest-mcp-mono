import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';

const mockLoadConfig = vi.mocked(loadConfig);
const mockExistsSync = vi.mocked(existsSync);

const baseEnv = {
  chainId: 'test-chain-1',
  rpcUrl: 'https://rpc.example.com',
  gasPrice: '0.01umfx',
  addressPrefix: 'manifest',
  keyfilePath: '/home/user/.manifest/key.json',
  keyPassword: undefined,
  mnemonic: undefined,
};

describe('bootstrap', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalArgv = process.argv;
    process.argv = ['node', 'manifest-mcp-chain'];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockLoadConfig.mockReturnValue(baseEnv as any);
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('exits with usage when unknown subcommand is given', async () => {
    process.argv = ['node', 'manifest-mcp-chain', 'bad-command'];

    bootstrap({
      cliName: 'manifest-mcp-chain',
      label: 'chain',
      createServer: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown subcommand'),
    );
  });

  it('exits when no wallet is found', async () => {
    mockExistsSync.mockReturnValue(false);
    mockLoadConfig.mockReturnValue({ ...baseEnv, mnemonic: undefined } as any);

    bootstrap({
      cliName: 'manifest-mcp-chain',
      label: 'chain',
      createServer: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No wallet found'),
    );
  });
});
