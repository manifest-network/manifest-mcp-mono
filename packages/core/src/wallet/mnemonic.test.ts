import { describe, expect, it } from 'vitest';
import { ManifestMCPError } from '../types.js';
import { MnemonicWalletProvider } from './mnemonic.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const TEST_CONFIG = {
  chainId: 'test-chain',
  rpcUrl: 'https://rpc.example.com',
  gasPrice: '1.0umfx',
  addressPrefix: 'manifest',
};

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
});
