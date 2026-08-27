import { existsSync } from 'node:fs';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { walletConnect, walletDisconnect } = vi.hoisted(() => ({
  walletConnect: vi.fn().mockResolvedValue(undefined),
  walletDisconnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('./config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('./keyfileWallet.js', () => ({
  KeyfileWalletProvider: class {
    connect = walletConnect;
    disconnect = walletDisconnect;
  },
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

function makeRuntime() {
  const sdkServer = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    onclose: undefined,
  } as unknown as Server;
  vi.mocked(sdkServer.close).mockImplementation(async () => {
    sdkServer.onclose?.();
  });
  const runtime = {
    getServer: vi.fn().mockReturnValue(sdkServer),
    disconnect: vi.fn(),
  };
  return { sdkServer, runtime };
}

describe('bootstrap', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('stdin EOF closes the transport, client manager, and wallet exactly once', async () => {
    mockExistsSync.mockReturnValue(true);
    const priorEndListeners = new Set(process.stdin.listeners('end'));
    const { sdkServer, runtime } = makeRuntime();

    bootstrap({
      cliName: 'manifest-mcp-chain',
      label: 'chain',
      createServer: vi.fn().mockReturnValue(runtime),
    });

    await vi.waitFor(() => {
      expect(sdkServer.connect).toHaveBeenCalledTimes(1);
    });
    const endListener = process.stdin
      .listeners('end')
      .find((listener) => !priorEndListeners.has(listener));
    expect(endListener).toBeDefined();

    endListener?.();
    await vi.waitFor(() => {
      expect(walletDisconnect).toHaveBeenCalledTimes(1);
    });

    expect(walletConnect).toHaveBeenCalledTimes(1);
    expect(sdkServer.close).toHaveBeenCalledTimes(1);
    expect(runtime.disconnect).toHaveBeenCalledTimes(1);

    // A competing close event must join the same cleanup operation.
    endListener?.();
    await Promise.resolve();
    expect(sdkServer.close).toHaveBeenCalledTimes(1);
    expect(runtime.disconnect).toHaveBeenCalledTimes(1);
    expect(walletDisconnect).toHaveBeenCalledTimes(1);
  });

  it('transport close tears down the client manager and wallet', async () => {
    mockExistsSync.mockReturnValue(true);
    const { sdkServer, runtime } = makeRuntime();

    bootstrap({
      cliName: 'manifest-mcp-chain',
      label: 'chain',
      createServer: vi.fn().mockReturnValue(runtime),
    });

    await vi.waitFor(() => {
      expect(sdkServer.connect).toHaveBeenCalledTimes(1);
    });
    sdkServer.onclose?.();
    await vi.waitFor(() => {
      expect(walletDisconnect).toHaveBeenCalledTimes(1);
    });

    expect(sdkServer.close).toHaveBeenCalledTimes(1);
    expect(runtime.disconnect).toHaveBeenCalledTimes(1);
  });

  it('SIGTERM waits for cleanup before exiting with the conventional code', async () => {
    mockExistsSync.mockReturnValue(true);
    const priorTermListeners = new Set(process.listeners('SIGTERM'));
    const { sdkServer, runtime } = makeRuntime();

    bootstrap({
      cliName: 'manifest-mcp-chain',
      label: 'chain',
      createServer: vi.fn().mockReturnValue(runtime),
    });

    await vi.waitFor(() => {
      expect(sdkServer.connect).toHaveBeenCalledTimes(1);
    });
    const termListener = process
      .listeners('SIGTERM')
      .find((listener) => !priorTermListeners.has(listener));
    expect(termListener).toBeDefined();

    termListener?.('SIGTERM');
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(143);
    });

    expect(sdkServer.close).toHaveBeenCalledTimes(1);
    expect(runtime.disconnect).toHaveBeenCalledTimes(1);
    expect(walletDisconnect).toHaveBeenCalledTimes(1);
  });
});
