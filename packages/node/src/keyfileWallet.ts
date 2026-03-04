import { readFileSync } from 'node:fs';
import { DirectSecp256k1HdWallet, type OfflineSigner } from '@cosmjs/proto-signing';
import { Secp256k1HdWallet } from '@cosmjs/amino';
import { toBase64 } from '@cosmjs/encoding';
import {
  type WalletProvider,
  type SignArbitraryResult,
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';

export class KeyfileWalletProvider implements WalletProvider {
  private keyfilePath: string;
  private addressPrefix: string;
  private password: string | undefined;
  private wallet: DirectSecp256k1HdWallet | null = null;
  private aminoWallet: Secp256k1HdWallet | null = null;
  private address: string | null = null;
  private disconnected = false;

  // Promise to prevent concurrent wallet initialization
  private initPromise: Promise<void> | null = null;

  constructor(keyfilePath: string, addressPrefix: string, password?: string) {
    this.keyfilePath = keyfilePath;
    this.addressPrefix = addressPrefix;
    this.password = password;
  }

  async connect(): Promise<void> {
    if (this.disconnected) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet has been disconnected. Create a new KeyfileWalletProvider instance to reconnect.'
      );
    }
    if (this.wallet) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doConnect();
    return this.initPromise;
  }

  private async doConnect(): Promise<void> {
    try {
      let raw: string;
      try {
        raw = readFileSync(this.keyfilePath, 'utf-8');
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
            `Keyfile not found at ${this.keyfilePath}. Run "manifest-mcp-node keygen" to generate one, or check MANIFEST_KEY_FILE.`
          );
        }
        if (code === 'EACCES') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
            `Permission denied reading keyfile at ${this.keyfilePath}. Check file permissions (expected mode 0600).`
          );
        }
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          `Failed to read keyfile at ${this.keyfilePath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          `Keyfile at ${this.keyfilePath} contains invalid JSON. The file may be corrupted. Regenerate with "manifest-mcp-node keygen" or "manifest-mcp-node import".`
        );
      }

      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          `Keyfile at ${this.keyfilePath} does not contain a valid JSON object. Expected a CosmJS encrypted wallet or a JSON object with a "mnemonic" field.`
        );
      }

      const obj = data as Record<string, unknown>;

      if (obj.type !== undefined) {
        if (!this.password?.trim()) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
            'Keyfile is encrypted but no password provided. Set MANIFEST_KEY_PASSWORD to the password used when the keyfile was created.'
          );
        }
        try {
          this.wallet = await DirectSecp256k1HdWallet.deserialize(raw, this.password);
        } catch (err: unknown) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
            `Failed to decrypt keyfile at ${this.keyfilePath}. Verify that MANIFEST_KEY_PASSWORD is correct. (${err instanceof Error ? err.message : String(err)})`
          );
        }
      } else if (obj.mnemonic) {
        if (typeof obj.mnemonic !== 'string') {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
            `Keyfile at ${this.keyfilePath} has a "mnemonic" field that is not a string. Expected a BIP-39 mnemonic phrase.`
          );
        }
        try {
          this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(obj.mnemonic, {
            prefix: this.addressPrefix,
          });
        } catch (err: unknown) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.INVALID_MNEMONIC,
            `Invalid mnemonic in keyfile at ${this.keyfilePath}. The stored mnemonic may be corrupted. (${err instanceof Error ? err.message : String(err)})`
          );
        }
      } else {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          `Unrecognized keyfile format in ${this.keyfilePath}. Expected a CosmJS encrypted wallet or a JSON object with a "mnemonic" field.`
        );
      }

      try {
        this.aminoWallet = await Secp256k1HdWallet.fromMnemonic(this.wallet.mnemonic, {
          prefix: this.addressPrefix,
        });
      } catch (err: unknown) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          `Failed to initialize amino signing wallet from keyfile at ${this.keyfilePath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      let accounts;
      try {
        accounts = await this.wallet.getAccounts();
      } catch (err: unknown) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          `Failed to derive accounts from keyfile at ${this.keyfilePath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (accounts.length === 0) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          'No accounts derived from keyfile'
        );
      }
      this.address = accounts[0].address;
      if (!this.address.startsWith(this.addressPrefix)) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.WALLET_CONNECTION_FAILED,
          `Keyfile address prefix mismatch: keyfile produced "${this.address.slice(0, this.address.indexOf('1'))}" but config expects "${this.addressPrefix}". Regenerate the keyfile with the correct COSMOS_ADDRESS_PREFIX.`
        );
      }
      // Clear password from memory only after full initialization succeeds,
      // so that a retry after a partial failure can still use it.
      this.password = undefined;
      this.initPromise = null;
    } catch (error) {
      this.initPromise = null;
      this.wallet = null;
      this.aminoWallet = null;
      this.address = null;
      throw error;
    }
  }

  async getAddress(): Promise<string> {
    await this.connect();

    if (!this.address) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet failed to initialize'
      );
    }
    return this.address;
  }

  async getSigner(): Promise<OfflineSigner> {
    await this.connect();

    if (!this.wallet) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Wallet failed to initialize'
      );
    }
    return this.wallet;
  }

  async disconnect(): Promise<void> {
    this.wallet = null;
    this.aminoWallet = null;
    this.address = null;
    this.password = undefined;
    this.disconnected = true;
    this.initPromise = null;
  }

  async signArbitrary(address: string, data: string): Promise<SignArbitraryResult> {
    await this.connect();

    if (!this.aminoWallet) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
        'Amino wallet failed to initialize'
      );
    }

    if (address !== this.address) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.INVALID_ADDRESS,
        `Cannot sign for address "${address}": wallet address is "${this.address}"`
      );
    }

    const signDoc = {
      chain_id: '',
      account_number: '0',
      sequence: '0',
      fee: { gas: '0', amount: [] },
      msgs: [
        {
          type: 'sign/MsgSignData',
          value: {
            signer: address,
            data: toBase64(new TextEncoder().encode(data)),
          },
        },
      ],
      memo: '',
    };

    const { signature } = await this.aminoWallet.signAmino(address, signDoc);
    return {
      pub_key: signature.pub_key,
      signature: signature.signature,
    };
  }
}
