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
    // Note: JavaScript strings are immutable, so we can't truly zero the memory,
    // but we remove all references to allow garbage collection.
    this.privateKeyHex = '';
    this.disconnected = true;
    this.initPromise = null;
  }
}

// Dummy EVM chain config required by the Web3Auth Node SDK to initialise its
// internal provider. We never broadcast to this chain — it is only used to
// extract the raw secp256k1 private key.  Mainnet chainId '0x1' is used because
// the Web3Auth SDK validates the chainId and some configurations reject testnets.
const DUMMY_EVM_CHAIN = {
  chainNamespace: 'eip155',
  chainId: '0x1',
  rpcTarget: 'https://rpc.ankr.com/eth',
  displayName: 'Ethereum',
  blockExplorerUrl: 'https://etherscan.io',
  ticker: 'ETH',
  tickerName: 'Ethereum',
  logo: '',
} as const;

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
    chains: [DUMMY_EVM_CHAIN],
  });

  try {
    await web3auth.init();
  } catch (err: unknown) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
      `Web3Auth SDK initialization failed. Verify WEB3AUTH_CLIENT_ID and WEB3AUTH_NETWORK are correct. ` +
      `(${err instanceof Error ? err.message : String(err)})`
    );
  }

  let result: Awaited<ReturnType<typeof web3auth.connect>>;
  try {
    result = await web3auth.connect({
      idToken,
      authConnectionId: web3authConfig.verifier,
      userId: verifierId,
    });
  } catch (err: unknown) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
      `Web3Auth connect failed. The OAuth token may be expired or WEB3AUTH_VERIFIER may be misconfigured. ` +
      `(${err instanceof Error ? err.message : String(err)})`
    );
  }

  if (!result?.provider) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
      'Web3Auth connect returned no provider. Verify WEB3AUTH_VERIFIER and WEB3AUTH_CLIENT_ID are correct.'
    );
  }

  const privateKey = await result.provider.request({ method: 'private_key' });

  if (!privateKey || typeof privateKey !== 'string') {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
      'Web3Auth did not return a valid private key'
    );
  }

  // Strip optional 0x prefix and validate 32-byte hex (64 hex characters).
  const hex = privateKey.startsWith('0x') || privateKey.startsWith('0X')
    ? privateKey.slice(2)
    : privateKey;

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
      'Web3Auth returned a private key in an unexpected format. Expected 32-byte hex string (64 hex characters).'
    );
  }

  return hex;
}
