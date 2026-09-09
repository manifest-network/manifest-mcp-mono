import {
  CosmosClientManager,
  ManifestMCPErrorCode,
  type WalletProvider,
} from '@manifest-network/manifest-mcp-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFredClientNode } from './node.js';

const config = {
  chainId: 'trusted-local-chain',
  rpcUrl: 'http://127.0.0.1:26657',
  restUrl: 'http://127.0.0.1:1317/prefix',
  gasPrice: '0.025umfx',
  retry: { maxRetries: 0 },
};
const walletProvider: WalletProvider = {
  getAddress: vi.fn(),
  getSigner: vi.fn(),
};

afterEach(() => {
  CosmosClientManager.clearInstances();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('public Node Fred factory chain/provider transport separation', () => {
  it('accepts an operator-configured local chain while its real provider guard still blocks loopback', async () => {
    // Only the operator's identity response is stubbed. The complete factories,
    // LCD construction, and Node provider SSRF guard run as shipped.
    const identityFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ default_node_info: { network: config.chainId } }),
    );
    vi.stubGlobal('fetch', identityFetch);
    const client = await createFredClientNode({ config, walletProvider });
    try {
      expect(identityFetch).toHaveBeenCalledWith(
        `${config.restUrl}/cosmos/base/tendermint/v1beta1/node_info`,
        expect.objectContaining({ redirect: 'error' }),
      );
      expect(client.allowLoopback).toBe(false);
      // Undici's connect hook rejects this before connecting. No real HTTP
      // server/network is needed, and the mocked global fetch is not consulted.
      await expect(
        client.fetch('http://127.0.0.1:1317/health'),
      ).rejects.toMatchObject({
        cause: { message: expect.stringContaining('SSRF blocked: 127.0.0.1') },
      });
      expect(identityFetch).toHaveBeenCalledOnce();
      expect(walletProvider.getSigner).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });

  it('still rejects a local chain identity mismatch through the explicit identity transport', async () => {
    const identityFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ default_node_info: { network: 'different-chain' } }),
    );
    await expect(
      createFredClientNode({
        config,
        walletProvider,
        chainIdentityFetch: identityFetch,
      }),
    ).rejects.toMatchObject({ code: ManifestMCPErrorCode.INVALID_CONFIG });
    expect(identityFetch).toHaveBeenCalledOnce();
    expect(walletProvider.getSigner).not.toHaveBeenCalled();
  });
});
