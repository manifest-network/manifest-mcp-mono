import { Secp256k1HdWallet } from '@cosmjs/amino';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { MnemonicWalletProvider } from './mnemonic.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const TEST_CONFIG = {
  chainId: 'test-chain',
  rpcUrl: 'https://rpc.example.com',
  gasPrice: '1.0umfx',
  addressPrefix: 'manifest',
};

afterEach(() => vi.restoreAllMocks());

describe('MnemonicWalletProvider', () => {
  it('derives a manifest1... address from a valid mnemonic', async () => {
    const wallet = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    await wallet.connect();
    const address = await wallet.getAddress();
    expect(address).toMatch(/^manifest1/);
  });

  it('uses custom address prefix', async () => {
    const wallet = new MnemonicWalletProvider(
      { ...TEST_CONFIG, addressPrefix: 'cosmos' },
      TEST_MNEMONIC,
    );
    await wallet.connect();
    const address = await wallet.getAddress();
    expect(address).toMatch(/^cosmos1/);
  });

  it('returns an offline signer', async () => {
    const wallet = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    await wallet.connect();
    const signer = await wallet.getSigner();
    expect(signer).toBeDefined();
    const accounts = await signer.getAccounts();
    expect(accounts.length).toBeGreaterThan(0);
  });

  it('lazy-inits on getAddress without explicit connect', async () => {
    const wallet = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    const address = await wallet.getAddress();
    expect(address).toMatch(/^manifest1/);
  });

  it('prevents reconnection after disconnect', async () => {
    const wallet = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    await wallet.connect();
    await wallet.disconnect();

    await expect(wallet.connect()).rejects.toThrow('disconnected');
    await expect(wallet.getAddress()).rejects.toThrow('disconnected');
  });

  it('throws for invalid mnemonic', async () => {
    const wallet = new MnemonicWalletProvider(TEST_CONFIG, 'invalid words');

    await expect(wallet.connect()).rejects.toThrow(ManifestMCPError);
  });

  it('supports signArbitrary', async () => {
    const wallet = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    await wallet.connect();
    const address = await wallet.getAddress();
    const result = await wallet.signArbitrary(address, 'hello');
    expect(result.pub_key).toBeDefined();
    expect(result.signature).toBeDefined();
  });

  it('signArbitrary rejects wrong address', async () => {
    const wallet = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    await wallet.connect();

    await expect(
      wallet.signArbitrary('manifest1wrong', 'hello'),
    ).rejects.toThrow('Cannot sign for address');
  });

  it('handles concurrent connect calls', async () => {
    const wallet = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    const [a1, a2] = await Promise.all([
      wallet.getAddress(),
      wallet.getAddress(),
    ]);
    expect(a1).toBe(a2);
  });

  it.each(['direct', 'amino', 'accounts'] as const)(
    'disconnect during %s initialization rejects waiting callers without retaining derived keys',
    async (stage) => {
      const direct = await DirectSecp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
        prefix: 'manifest',
      });
      const amino = await Secp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
        prefix: 'manifest',
      });
      const accounts = await direct.getAccounts();
      let release = () => {};
      let markEntered = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      function pause<T>(value: T): Promise<T> {
        markEntered();
        return gate.then(() => value);
      }
      vi.spyOn(DirectSecp256k1HdWallet, 'fromMnemonic').mockImplementation(
        () => (stage === 'direct' ? pause(direct) : Promise.resolve(direct)),
      );
      vi.spyOn(Secp256k1HdWallet, 'fromMnemonic').mockImplementation(() =>
        stage === 'amino' ? pause(amino) : Promise.resolve(amino),
      );
      if (stage === 'accounts') {
        vi.spyOn(direct, 'getAccounts').mockImplementation(() =>
          pause(accounts),
        );
      }
      const provider = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
      const waiting = Promise.allSettled([
        provider.getSigner(),
        provider.getAddress(),
        provider.connect(),
      ]);
      await entered;
      await provider.disconnect();
      release();
      for (const result of await waiting) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { code: ManifestMCPErrorCode.WALLET_NOT_CONNECTED },
        });
      }
      for (const field of [
        'wallet',
        'aminoWallet',
        'address',
        'mnemonic',
        'initPromise',
      ]) {
        expect(Reflect.get(provider, field)).toBeNull();
      }
      await expect(provider.getSigner()).rejects.toMatchObject({
        code: ManifestMCPErrorCode.WALLET_NOT_CONNECTED,
      });
    },
  );

  it('retries a synchronous initialization failure instead of caching its rejected promise', async () => {
    const fromMnemonic = vi.spyOn(DirectSecp256k1HdWallet, 'fromMnemonic');
    fromMnemonic.mockImplementationOnce(() => {
      throw new Error('transient derivation failure');
    });
    const provider = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    await expect(provider.connect()).rejects.toThrow(
      'transient derivation failure',
    );
    await expect(provider.getAddress()).resolves.toMatch(/^manifest1/);
    expect(fromMnemonic).toHaveBeenCalledTimes(2);
  });

  it('keeps a partial initialization private and retries an amino failure', async () => {
    const fromMnemonic = vi.spyOn(Secp256k1HdWallet, 'fromMnemonic');
    fromMnemonic.mockRejectedValueOnce(new Error('amino derivation failed'));
    const provider = new MnemonicWalletProvider(TEST_CONFIG, TEST_MNEMONIC);
    await expect(provider.getSigner()).rejects.toThrow(
      'amino derivation failed',
    );
    expect(Reflect.get(provider, 'wallet')).toBeNull();
    await expect(provider.getSigner()).resolves.toBeInstanceOf(
      DirectSecp256k1HdWallet,
    );
    expect(fromMnemonic).toHaveBeenCalledTimes(2);
  });
});
