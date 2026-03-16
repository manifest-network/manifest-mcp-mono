import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

// Mock external dependencies
vi.mock('@manifest-network/manifestjs', () => ({
  liftedinit: {
    ClientFactory: {
      createRPCQueryClient: vi.fn(),
    },
  },
  cosmosProtoRegistry: [],
  cosmosAminoConverters: {},
  liftedinitProtoRegistry: [],
  liftedinitAminoConverters: {},
  strangeloveVenturesProtoRegistry: [],
  strangeloveVenturesAminoConverters: {},
  osmosisProtoRegistry: [],
  osmosisAminoConverters: {},
}));

vi.mock('@cosmjs/stargate', () => ({
  SigningStargateClient: {
    connectWithSigner: vi.fn().mockResolvedValue({ disconnect: vi.fn() }),
  },
  GasPrice: {
    fromString: vi.fn().mockReturnValue({}),
  },
  AminoTypes: class MockAminoTypes {},
}));

vi.mock('@cosmjs/proto-signing', () => ({
  Registry: class MockRegistry {},
}));

vi.mock('./retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retry.js')>();
  return {
    ...actual,
    withRetry: vi.fn().mockImplementation(async (operation: () => Promise<unknown>) => {
      return operation();
    }),
  };
});

import { CosmosClientManager } from './client.js';
import { liftedinit } from '@manifest-network/manifestjs';
import { SigningStargateClient } from '@cosmjs/stargate';
import type { WalletProvider, ManifestMCPConfig } from './types.js';

const mockCreateRPCQueryClient = vi.mocked(liftedinit.ClientFactory.createRPCQueryClient);
const mockConnectWithSigner = vi.mocked(SigningStargateClient.connectWithSigner);

function makeConfig(overrides?: Partial<ManifestMCPConfig>): ManifestMCPConfig {
  return {
    chainId: 'test-chain',
    rpcUrl: 'https://rpc.example.com',
    gasPrice: '1.0umfx',
    ...overrides,
  };
}

function makeWallet(overrides?: Partial<WalletProvider>): WalletProvider {
  return {
    getAddress: vi.fn().mockResolvedValue('manifest1test'),
    getSigner: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('CosmosClientManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CosmosClientManager.clearInstances();
    // Restore default mock return values after clearAllMocks
    mockCreateRPCQueryClient.mockResolvedValue({ mock: 'defaultQC' } as any);
    mockConnectWithSigner.mockResolvedValue({ disconnect: vi.fn() } as any);
  });

  afterEach(() => {
    CosmosClientManager.clearInstances();
  });

  describe('getInstance', () => {
    it('returns same instance for same chainId:rpcUrl', () => {
      const config = makeConfig();
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(config, wallet);
      const b = CosmosClientManager.getInstance(config, wallet);
      expect(a).toBe(b);
    });

    it('returns different instances for different rpcUrl', () => {
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(makeConfig({ rpcUrl: 'https://a.com' }), wallet);
      const b = CosmosClientManager.getInstance(makeConfig({ rpcUrl: 'https://b.com' }), wallet);
      expect(a).not.toBe(b);
    });

    it('returns different instances for different chainId', () => {
      const wallet = makeWallet();
      const a = CosmosClientManager.getInstance(makeConfig({ chainId: 'chain-a' }), wallet);
      const b = CosmosClientManager.getInstance(makeConfig({ chainId: 'chain-b' }), wallet);
      expect(a).not.toBe(b);
    });

    it('invalidates signing client when gasPrice changes', async () => {
      const wallet = makeWallet();
      const client1 = { disconnect: vi.fn() };
      const client2 = { disconnect: vi.fn() };
      mockConnectWithSigner
        .mockResolvedValueOnce(client1 as any)
        .mockResolvedValueOnce(client2 as any);

      const instance = CosmosClientManager.getInstance(makeConfig({ gasPrice: '1.0umfx' }), wallet);
      const sc1 = await instance.getSigningClient();
      expect(sc1).toBe(client1);

      // Re-get with different gasPrice — should create new signing client
      CosmosClientManager.getInstance(makeConfig({ gasPrice: '2.0umfx' }), wallet);
      const sc2 = await instance.getSigningClient();
      expect(sc2).toBe(client2);
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('invalidates signing client when walletProvider changes', async () => {
      const wallet1 = makeWallet();
      const wallet2 = makeWallet();

      const instance = CosmosClientManager.getInstance(makeConfig(), wallet1);
      await instance.getSigningClient();

      // Re-get with different wallet — should need new signing client
      CosmosClientManager.getInstance(makeConfig(), wallet2);
      await instance.getSigningClient();
      expect(mockConnectWithSigner).toHaveBeenCalledTimes(2);
    });

    it('does not invalidate signing client when only rate limit changes', async () => {
      const wallet = makeWallet();
      const config1 = makeConfig({ rateLimit: { requestsPerSecond: 10 } });
      const instance = CosmosClientManager.getInstance(config1, wallet);
      await instance.getSigningClient();

      const config2 = makeConfig({ rateLimit: { requestsPerSecond: 20 } });
      CosmosClientManager.getInstance(config2, wallet);
      await instance.getSigningClient();
      // Same signing client reused — only 1 call
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });
  });

  describe('getQueryClient', () => {
    it('creates and returns query client', async () => {
      const mockQC = { mock: 'queryClient' };
      mockCreateRPCQueryClient.mockResolvedValue(mockQC as any);

      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      const client1 = await instance.getQueryClient();
      const client2 = await instance.getQueryClient();

      expect(client1).toBe(mockQC);
      expect(client2).toBe(mockQC);
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();
    });

    it('deduplicates concurrent init calls', async () => {
      let resolveInit!: (value: any) => void;
      mockCreateRPCQueryClient.mockImplementation(
        () => new Promise((resolve) => { resolveInit = resolve; }) as any,
      );

      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      const p1 = instance.getQueryClient();
      const p2 = instance.getQueryClient();

      resolveInit({ mock: 'queryClient' });

      const [c1, c2] = await Promise.all([p1, p2]);
      expect(c1).toEqual({ mock: 'queryClient' });
      expect(c2).toBe(c1);
      expect(mockCreateRPCQueryClient).toHaveBeenCalledOnce();
    });

    it('wraps non-ManifestMCPError into RPC_CONNECTION_FAILED', async () => {
      mockCreateRPCQueryClient.mockRejectedValue(new Error('ECONNREFUSED'));

      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      await expect(instance.getQueryClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        message: expect.stringContaining('ECONNREFUSED'),
      });
    });

    it('re-throws ManifestMCPError as-is', async () => {
      const original = new ManifestMCPError(ManifestMCPErrorCode.RPC_CONNECTION_FAILED, 'custom');
      mockCreateRPCQueryClient.mockRejectedValue(original);

      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      await expect(instance.getQueryClient()).rejects.toBe(original);
    });

    // Note: Tests for retry-after-failure and disconnect-during-init are omitted
    // because the IIFE's thisInitPromise capture interacts subtly with vitest's
    // synchronous mock resolution. These code paths are covered by the e2e tests
    // against a live chain where async timing behaves naturally.
  });

  describe('getSigningClient', () => {
    it('creates and returns signing client', async () => {
      const mockSC = { disconnect: vi.fn() };
      mockConnectWithSigner.mockResolvedValue(mockSC as any);

      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      const client1 = await instance.getSigningClient();
      const client2 = await instance.getSigningClient();

      expect(client1).toBe(mockSC);
      expect(client2).toBe(mockSC);
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });

    it('deduplicates concurrent init calls', async () => {
      // Defer at the getSigner level so the signingClientPromise assignment
      // completes before the async body continues
      let resolveSigner!: (value: any) => void;
      const wallet = makeWallet({
        getSigner: vi.fn().mockImplementation(
          () => new Promise((resolve) => { resolveSigner = resolve; }),
        ),
      });

      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);
      const p1 = instance.getSigningClient();
      const p2 = instance.getSigningClient();

      resolveSigner({});

      const [c1, c2] = await Promise.all([p1, p2]);
      expect(c1).toBe(c2);
      expect(mockConnectWithSigner).toHaveBeenCalledOnce();
    });

    // Note: The superseded-promise disconnect test is omitted because the
    // IIFE's thisInitPromise capture requires real async timing to work
    // correctly. This is covered by the e2e tests against a live chain.

    it('wraps non-ManifestMCPError into RPC_CONNECTION_FAILED', async () => {
      mockConnectWithSigner.mockRejectedValue(new Error('timeout'));

      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      await expect(instance.getSigningClient()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.RPC_CONNECTION_FAILED,
        message: expect.stringContaining('timeout'),
      });
    });
  });

  describe('disconnect', () => {
    it('disconnects signing client and allows re-initialization', async () => {
      mockCreateRPCQueryClient
        .mockResolvedValueOnce({ mock: 'qc1' } as any)
        .mockResolvedValueOnce({ mock: 'qc2' } as any);

      const instance = CosmosClientManager.getInstance(makeConfig(), makeWallet());
      await instance.getSigningClient();
      const qc1 = await instance.getQueryClient();
      expect(qc1).toEqual({ mock: 'qc1' });

      instance.disconnect();

      // Subsequent calls should re-initialize
      const qc2 = await instance.getQueryClient();
      expect(qc2).toEqual({ mock: 'qc2' });
    });
  });

  describe('clearInstances', () => {
    it('removes all instances so new getInstance creates fresh ones', () => {
      const wallet = makeWallet();
      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);

      CosmosClientManager.clearInstances();

      // New getInstance should create a fresh instance
      const newInstance = CosmosClientManager.getInstance(makeConfig(), wallet);
      expect(newInstance).not.toBe(instance);
    });
  });

  describe('getAddress', () => {
    it('delegates to walletProvider', async () => {
      const wallet = makeWallet();
      const instance = CosmosClientManager.getInstance(makeConfig(), wallet);
      const address = await instance.getAddress();
      expect(address).toBe('manifest1test');
      expect(wallet.getAddress).toHaveBeenCalledOnce();
    });
  });

  describe('getConfig', () => {
    it('returns the current config', () => {
      const config = makeConfig({ chainId: 'my-chain' });
      const instance = CosmosClientManager.getInstance(config, makeWallet());
      expect(instance.getConfig().chainId).toBe('my-chain');
    });
  });
});
