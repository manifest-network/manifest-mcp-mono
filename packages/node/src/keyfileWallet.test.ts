import {
  ManifestMCPError,
  ManifestMCPErrorCode,
} from '@manifest-network/manifest-mcp-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A valid 24-word test mnemonic (DO NOT use in production)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { KeyfileWalletProvider } from './keyfileWallet.js';

const mockedReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KeyfileWalletProvider', () => {
  describe('connect from plaintext mnemonic keyfile', () => {
    it('should derive a manifest1... address', async () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ mnemonic: TEST_MNEMONIC }),
      );
      const provider = new KeyfileWalletProvider('/fake/key.json', 'manifest');
      await provider.connect();
      const address = await provider.getAddress();
      expect(address).toMatch(/^manifest1/);
    });
  });

  describe('connect failures', () => {
    it('should throw for missing file (ENOENT)', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      mockedReadFileSync.mockImplementation(() => {
        throw err;
      });

      const provider = new KeyfileWalletProvider(
        '/missing/key.json',
        'manifest',
      );
      await expect(provider.connect()).rejects.toThrow(ManifestMCPError);
      await expect(provider.connect()).rejects.toThrow(/Keyfile not found/);
    });

    it('should throw for permission denied (EACCES)', async () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      mockedReadFileSync.mockImplementation(() => {
        throw err;
      });

      const provider = new KeyfileWalletProvider(
        '/secret/key.json',
        'manifest',
      );
      await expect(provider.connect()).rejects.toThrow(ManifestMCPError);
      await expect(provider.connect()).rejects.toThrow(/Permission denied/);
    });

    it('should throw for invalid JSON', async () => {
      mockedReadFileSync.mockReturnValue('not-json{{{');

      const provider = new KeyfileWalletProvider('/bad/key.json', 'manifest');
      await expect(provider.connect()).rejects.toThrow(ManifestMCPError);
      await expect(provider.connect()).rejects.toThrow(/invalid JSON/);
    });

    it('should throw for encrypted keyfile without password', async () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ type: 'directsecp256k1hdwallet-v1', data: 'xyz' }),
      );

      const provider = new KeyfileWalletProvider('/enc/key.json', 'manifest');
      await expect(provider.connect()).rejects.toThrow(ManifestMCPError);
      await expect(provider.connect()).rejects.toThrow(/no password provided/);
    });

    it('should throw for unrecognized format', async () => {
      mockedReadFileSync.mockReturnValue(JSON.stringify({ foo: 'bar' }));

      const provider = new KeyfileWalletProvider('/weird/key.json', 'manifest');
      await expect(provider.connect()).rejects.toThrow(ManifestMCPError);
      await expect(provider.connect()).rejects.toThrow(
        /Unrecognized keyfile format/,
      );
    });

    it('should throw for non-string mnemonic field', async () => {
      mockedReadFileSync.mockReturnValue(JSON.stringify({ mnemonic: 12345 }));

      const provider = new KeyfileWalletProvider(
        '/bad-mnemonic/key.json',
        'manifest',
      );
      await expect(provider.connect()).rejects.toThrow(ManifestMCPError);
      await expect(provider.connect()).rejects.toThrow(/not a string/);
    });

    it('should throw for invalid mnemonic words', async () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ mnemonic: 'not a valid mnemonic phrase at all' }),
      );

      const provider = new KeyfileWalletProvider(
        '/bad-words/key.json',
        'manifest',
      );
      await expect(provider.connect()).rejects.toThrow(ManifestMCPError);
      try {
        await provider.connect();
      } catch (err) {
        expect((err as ManifestMCPError).code).toBe(
          ManifestMCPErrorCode.INVALID_MNEMONIC,
        );
      }
    });
  });

  describe('signArbitrary', () => {
    it('should sign for the correct address', async () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ mnemonic: TEST_MNEMONIC }),
      );
      const provider = new KeyfileWalletProvider('/fake/key.json', 'manifest');
      await provider.connect();
      const address = await provider.getAddress();

      const result = await provider.signArbitrary(address, 'test-data');
      expect(result.pub_key).toBeDefined();
      expect(result.pub_key.type).toBe('tendermint/PubKeySecp256k1');
      expect(result.pub_key.value).toBeTruthy();
      expect(result.signature).toBeTruthy();
    });

    it('should throw for wrong address', async () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ mnemonic: TEST_MNEMONIC }),
      );
      const provider = new KeyfileWalletProvider('/fake/key.json', 'manifest');
      await provider.connect();

      await expect(
        provider.signArbitrary('manifest1wrong', 'test-data'),
      ).rejects.toThrow(ManifestMCPError);
      await expect(
        provider.signArbitrary('manifest1wrong', 'test-data'),
      ).rejects.toThrow(/Cannot sign for address/);
    });
  });

  describe('disconnect', () => {
    it('should prevent reconnection after disconnect', async () => {
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({ mnemonic: TEST_MNEMONIC }),
      );
      const provider = new KeyfileWalletProvider('/fake/key.json', 'manifest');
      await provider.connect();
      await provider.disconnect();

      await expect(provider.connect()).rejects.toThrow(ManifestMCPError);
      await expect(provider.connect()).rejects.toThrow(/has been disconnected/);
    });
  });
});
