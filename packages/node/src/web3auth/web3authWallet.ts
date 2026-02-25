import { DirectSecp256k1Wallet, type OfflineSigner } from '@cosmjs/proto-signing';
import { fromHex } from '@cosmjs/encoding';
import {
  type WalletProvider,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import type { Web3AuthConfig } from './types.js';

export class Web3AuthWalletProvider implements WalletProvider {
  private privateKeyHex: string;
  private addressPrefix: string;
  private wallet: DirectSecp256k1Wallet | null = null;
  private address: string | null = null;
  private disconnected = false;
  private initPromise: Promise<void> | null = null;

  constructor(privateKeyHex: string, addressPrefix: string) {
    this.privateKeyHex = privateKeyHex;
    this.addressPrefix = addressPrefix;
  }

  async connect(): Promise<void> {
    if (this.disconnected) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet has been disconnected. Create a new Web3AuthWalletProvider instance to reconnect.'
      );
    }
    if (this.wallet) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doConnect();
    return this.initPromise;
  }

  private async doConnect(): Promise<void> {
    try {
      const keyBytes = fromHex(this.privateKeyHex);
      this.wallet = await DirectSecp256k1Wallet.fromKey(keyBytes, this.addressPrefix);
      const accounts = await this.wallet.getAccounts();
      if (accounts.length === 0) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          'No accounts derived from Web3Auth private key'
        );
      }
      this.address = accounts[0].address;
      this.initPromise = null;
    } catch (error) {
      this.initPromise = null;
      this.wallet = null;
      this.address = null;
      if (error instanceof ManifestMCPError) throw error;
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
        `Failed to initialize Web3Auth wallet: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getAddress(): Promise<string> {
    await this.connect();
    if (!this.address) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Web3Auth wallet failed to initialize'
      );
    }
    return this.address;
  }

  async getSigner(): Promise<OfflineSigner> {
    await this.connect();
    if (!this.wallet) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Web3Auth wallet failed to initialize'
      );
    }
    return this.wallet;
  }

  async disconnect(): Promise<void> {
    this.wallet = null;
    this.address = null;
    this.privateKeyHex = '';
    this.disconnected = true;
    this.initPromise = null;
  }
}

export async function extractPrivateKey(
  web3authConfig: Web3AuthConfig,
  idToken: string,
  verifierId: string,
): Promise<string> {
  // Dynamic import — only needed during login.
  // Types come from node-sdk.d.ts shim (avoids viem/ox raw .ts build failures).
  const { Web3Auth } = await import('@web3auth/node-sdk');

  const web3auth = new Web3Auth({
    clientId: web3authConfig.clientId,
    web3AuthNetwork: web3authConfig.network,
    // Dummy EVM chain config required by the SDK; we only extract the raw key
    chains: [{
      chainNamespace: 'eip155',
      chainId: '0x1',
      rpcTarget: 'https://rpc.ankr.com/eth',
      displayName: 'Ethereum',
      blockExplorerUrl: 'https://etherscan.io',
      ticker: 'ETH',
      tickerName: 'Ethereum',
      logo: '',
    }],
  });

  await web3auth.init();

  const result = await web3auth.connect({
    idToken,
    authConnectionId: web3authConfig.verifier,
    userId: verifierId,
  });

  const privateKey = await result.provider.request({ method: 'private_key' });

  if (!privateKey || typeof privateKey !== 'string') {
    throw new Error('Web3Auth did not return a valid private key');
  }

  return privateKey;
}
