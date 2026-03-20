import { Secp256k1HdWallet } from '@cosmjs/amino';
import { describe, expect, it } from 'vitest';
import { ManifestMCPError } from '../types.js';
import { signArbitraryWithAmino } from './sign-arbitrary.js';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('signArbitraryWithAmino', () => {
  let wallet: Secp256k1HdWallet;
  let walletAddress: string;

  it('produces a valid signature', async () => {
    wallet = await Secp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    const accounts = await wallet.getAccounts();
    walletAddress = accounts[0].address;

    const result = await signArbitraryWithAmino(
      wallet,
      walletAddress,
      walletAddress,
      'test data',
    );

    expect(result.pub_key).toHaveProperty('type');
    expect(result.pub_key).toHaveProperty('value');
    expect(typeof result.signature).toBe('string');
    expect(result.signature.length).toBeGreaterThan(0);
  });

  it('throws when signing for a different address', async () => {
    wallet = await Secp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    const accounts = await wallet.getAccounts();
    walletAddress = accounts[0].address;

    await expect(
      signArbitraryWithAmino(
        wallet,
        walletAddress,
        'manifest1wrongaddress',
        'test data',
      ),
    ).rejects.toThrow(ManifestMCPError);
  });

  it('signs different data deterministically', async () => {
    wallet = await Secp256k1HdWallet.fromMnemonic(TEST_MNEMONIC, {
      prefix: 'manifest',
    });
    const accounts = await wallet.getAccounts();
    walletAddress = accounts[0].address;

    const sig1 = await signArbitraryWithAmino(
      wallet,
      walletAddress,
      walletAddress,
      'data-a',
    );
    const sig2 = await signArbitraryWithAmino(
      wallet,
      walletAddress,
      walletAddress,
      'data-b',
    );

    expect(sig1.signature).not.toBe(sig2.signature);
    expect(sig1.pub_key.value).toBe(sig2.pub_key.value);
  });
});
