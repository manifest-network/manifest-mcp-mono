import { DirectSecp256k1HdWallet, OfflineSigner } from '@cosmjs/proto-signing';
import { WalletProvider, ManifestMCPError, ManifestMCPErrorCode, ManifestMCPConfig } from '../types.js';

/**
 * Mnemonic-based wallet provider for non-browser environments or testing
 *
 * SECURITY NOTE: The mnemonic is stored in memory until disconnect() is called.
 * After disconnect(), the wallet cannot be reconnected - create a new instance instead.
 */
export class MnemonicWalletProvider implements WalletProvider {
  private config: ManifestMCPConfig;
  private mnemonic: string | null;
  private wallet: DirectSecp256k1HdWallet | null = null;
  private address: string | null = null;
  private disconnected: boolean = false;

  // Promise to prevent concurrent wallet initialization (lazy init race condition)
  private initPromise: Promise<void> | null = null;

  constructor(config: ManifestMCPConfig, mnemonic: string) {
    this.config = config;
    this.mnemonic = mnemonic;
  }

  /**
   * Initialize the wallet from the mnemonic
   */
  private async initWallet(): Promise<void> {
    if (this.disconnected) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet has been disconnected and cannot be reconnected. Create a new MnemonicWalletProvider instance.'
      );
    }

    // Return if already initialized
    if (this.wallet) {
      return;
    }

    // If initialization is already in progress, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    if (!this.mnemonic) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Mnemonic has been cleared. Create a new MnemonicWalletProvider instance.'
      );
    }

    // Start initialization and cache the promise to prevent concurrent init
    this.initPromise = (async () => {
      const prefix = this.config.addressPrefix ?? 'manifest';

      try {
        this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic!, {
          prefix,
        });

        const accounts = await this.wallet.getAccounts();
        if (accounts.length === 0) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_MNEMONIC,
            'No accounts derived from mnemonic'
          );
        }

        this.address = accounts[0].address;
        // Clear promise after successful init - wallet check will short-circuit future calls
        this.initPromise = null;
      } catch (error) {
        // Clear state on failure so retry is possible
        this.initPromise = null;
        this.wallet = null;
        this.address = null;
        if (error instanceof ManifestMCPError) {
          throw error;
        }
        throw new ManifestMCPError(
          ManifestMCPErrorCode.INVALID_MNEMONIC,
          `Failed to create wallet from mnemonic: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();

    return this.initPromise;
  }

  /**
   * Connect (initialize) the wallet
   */
  async connect(): Promise<void> {
    await this.initWallet();
  }

  /**
   * Disconnect and securely clear all sensitive data
   *
   * IMPORTANT: After calling disconnect(), this wallet instance cannot be reused.
   * Create a new MnemonicWalletProvider instance if you need to reconnect.
   */
  async disconnect(): Promise<void> {
    // Clear the mnemonic by overwriting with empty string then nullifying
    // Note: JavaScript strings are immutable, so we can't truly zero the memory,
    // but we can remove all references to allow garbage collection
    this.mnemonic = null;
    this.wallet = null;
    this.address = null;
    this.initPromise = null;
    this.disconnected = true;
  }

  /**
   * Get the wallet's address
   */
  async getAddress(): Promise<string> {
    await this.initWallet();

    if (!this.address) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet failed to initialize'
      );
    }

    return this.address;
  }

  /**
   * Get the offline signer for signing transactions
   */
  async getSigner(): Promise<OfflineSigner> {
    await this.initWallet();

    if (!this.wallet) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet failed to initialize'
      );
    }

    return this.wallet;
  }
}
