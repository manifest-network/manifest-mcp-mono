import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readEnvFile } = vi.hoisted(() => ({
  readEnvFile: vi.fn<() => string>(),
}));

// Keep dotenv's real parser/populator; isolate only the optional file read.
vi.mock('node:fs', () => ({ readFileSync: readEnvFile }));

beforeEach(() => {
  vi.resetModules();
  readEnvFile.mockReset().mockImplementation(() => {
    throw Object.assign(new Error('No .env file'), { code: 'ENOENT' });
  });
  // Clear all env vars we set in tests
  delete process.env.COSMOS_CHAIN_ID;
  delete process.env.COSMOS_RPC_URL;
  delete process.env.COSMOS_GAS_PRICE;
  delete process.env.COSMOS_REST_URL;
  delete process.env.COSMOS_ADDRESS_PREFIX;
  delete process.env.COSMOS_GAS_MULTIPLIER;
  delete process.env.COSMOS_MAX_GAS;
  delete process.env.COSMOS_MNEMONIC;
  delete process.env.MANIFEST_KEY_FILE;
  delete process.env.MANIFEST_KEY_PASSWORD;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function importConfig() {
  return import('./config.js');
}

describe('optional .env loading', () => {
  it('preserves dotenv quoting and byte-sensitive password escapes', async () => {
    readEnvFile.mockReturnValue(
      'COSMOS_CHAIN_ID: file-chain\n' +
        'COSMOS_REST_URL=https://rest.test.com\n' +
        'MANIFEST_KEY_PASSWORD="line1\\nline2\\r"\n',
    );

    const { loadConfig } = await importConfig();
    expect(loadConfig()).toMatchObject({
      chainId: 'file-chain',
      restUrl: 'https://rest.test.com',
      keyPassword: 'line1\nline2\r',
    });
    expect(readEnvFile).toHaveBeenCalledOnce();
  });

  it('keeps existing environment values, including an explicitly empty password', async () => {
    process.env.COSMOS_CHAIN_ID = 'existing-chain';
    process.env.MANIFEST_KEY_PASSWORD = '';
    readEnvFile.mockReturnValue(
      'COSMOS_CHAIN_ID=file-chain\n' +
        'COSMOS_REST_URL=https://rest.test.com\n' +
        'MANIFEST_KEY_PASSWORD=file-password\n',
    );

    const { loadConfig } = await importConfig();
    expect(loadConfig()).toMatchObject({
      chainId: 'existing-chain',
      restUrl: 'https://rest.test.com',
      keyPassword: '',
    });
  });

  it.each(['ENOENT', 'EACCES', 'EISDIR'])(
    'keeps optional file read failures non-fatal (%s)',
    async (code) => {
      readEnvFile.mockImplementation(() => {
        throw Object.assign(new Error('Optional file unavailable'), { code });
      });
      process.env.COSMOS_CHAIN_ID = 'existing-chain';
      process.env.COSMOS_REST_URL = 'https://rest.test.com';

      const { loadConfig } = await importConfig();
      expect(loadConfig().chainId).toBe('existing-chain');
      expect(readEnvFile).toHaveBeenCalledOnce();
    },
  );

  it.each(['parse', 'populate'] as const)(
    'does not swallow unexpected %s failures as optional file errors',
    async (operation) => {
      readEnvFile.mockReturnValue('COSMOS_CHAIN_ID=file-chain\n');
      const dotenv = (await import('dotenv')).default;
      const error = new Error(`Unexpected dotenv ${operation} failure`);
      vi.spyOn(dotenv, operation).mockImplementation(() => {
        throw error;
      });

      await expect(importConfig()).rejects.toBe(error);
    },
  );
});

describe('loadConfig', () => {
  it('should load required fields from env', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.chainId).toBe('test-chain');
    expect(config.rpcUrl).toBe('https://rpc.test.com');
    expect(config.gasPrice).toBe('0.025umfx');
  });

  it('should throw for missing COSMOS_CHAIN_ID', async () => {
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_CHAIN_ID/);
  });

  it('should throw when neither COSMOS_RPC_URL nor COSMOS_REST_URL is set', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_RPC_URL or COSMOS_REST_URL/);
  });

  it('should throw when COSMOS_RPC_URL is set without COSMOS_GAS_PRICE', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_GAS_PRICE/);
  });

  it('should accept COSMOS_REST_URL without COSMOS_RPC_URL', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_REST_URL = 'https://rest.test.com';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.restUrl).toBe('https://rest.test.com');
    expect(config.rpcUrl).toBeUndefined();
    expect(config.gasPrice).toBeUndefined();
  });

  it('should accept both COSMOS_RPC_URL and COSMOS_REST_URL', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_REST_URL = 'https://rest.test.com';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.rpcUrl).toBe('https://rpc.test.com');
    expect(config.restUrl).toBe('https://rest.test.com');
  });

  it('should default addressPrefix to "manifest"', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.addressPrefix).toBe('manifest');
  });

  it('should override addressPrefix from env', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_ADDRESS_PREFIX = 'cosmos';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.addressPrefix).toBe('cosmos');
  });

  it('should expand tilde in keyfilePath', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.MANIFEST_KEY_FILE = '~/my-key.json';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.keyfilePath).toBe(`${homedir()}/my-key.json`);
    expect(config.keyfilePath).not.toContain('~');
  });

  it('should parse COSMOS_GAS_MULTIPLIER as a number', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_GAS_MULTIPLIER = '2.0';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.gasMultiplier).toBe(2.0);
  });

  it('should leave gasMultiplier undefined when env var is not set', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.gasMultiplier).toBeUndefined();
  });

  it('should leave gasMultiplier undefined when env var is empty string', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_GAS_MULTIPLIER = '';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.gasMultiplier).toBeUndefined();
  });

  it('should throw for non-numeric COSMOS_GAS_MULTIPLIER', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_GAS_MULTIPLIER = 'abc';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_GAS_MULTIPLIER/);
  });

  it('should throw for COSMOS_GAS_MULTIPLIER less than 1', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_GAS_MULTIPLIER = '0.5';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_GAS_MULTIPLIER/);
  });

  it('should throw for COSMOS_GAS_MULTIPLIER with trailing garbage', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_GAS_MULTIPLIER = '2.0abc';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_GAS_MULTIPLIER/);
  });

  it('should throw for COSMOS_GAS_MULTIPLIER with denom suffix', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_GAS_MULTIPLIER = '1.5umfx';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_GAS_MULTIPLIER/);
  });

  it('should throw for Infinity COSMOS_GAS_MULTIPLIER', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_GAS_MULTIPLIER = 'Infinity';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_GAS_MULTIPLIER/);
  });

  it('should parse COSMOS_MAX_GAS as a number', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '10000000';

    const { loadConfig } = await importConfig();
    expect(loadConfig().maxGas).toBe(10_000_000);
  });

  it('should parse COSMOS_MAX_GAS of -1 (disabled)', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '-1';

    const { loadConfig } = await importConfig();
    expect(loadConfig().maxGas).toBe(-1);
  });

  it('should leave maxGas undefined when COSMOS_MAX_GAS is not set', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';

    const { loadConfig } = await importConfig();
    expect(loadConfig().maxGas).toBeUndefined();
  });

  it('should leave maxGas undefined when COSMOS_MAX_GAS is empty string', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '';

    const { loadConfig } = await importConfig();
    expect(loadConfig().maxGas).toBeUndefined();
  });

  it('should throw for non-numeric COSMOS_MAX_GAS', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = 'abc';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });

  it('should throw for zero COSMOS_MAX_GAS', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '0';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });

  it('should throw for a non-integer COSMOS_MAX_GAS', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '1.5';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });

  it('should throw for a negative COSMOS_MAX_GAS other than -1', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '-5';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });

  it('should throw for a COSMOS_MAX_GAS above the safe-integer range', async () => {
    // Number('9007199254740993') rounds lossily to 9007199254740992; isSafeInteger
    // rejects it rather than silently accepting a mis-parsed ceiling (ENG-556, Copilot review).
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_MAX_GAS = '9007199254740993';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_MAX_GAS/);
  });

  it('should fall back to default when env var is empty string', async () => {
    process.env.COSMOS_CHAIN_ID = 'test-chain';
    process.env.COSMOS_RPC_URL = 'https://rpc.test.com';
    process.env.COSMOS_GAS_PRICE = '0.025umfx';
    process.env.COSMOS_ADDRESS_PREFIX = '';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.addressPrefix).toBe('manifest');
  });
});

describe('loadKeyfileConfig', () => {
  it('should return defaults when no env set', async () => {
    const { loadKeyfileConfig } = await importConfig();
    const config = loadKeyfileConfig();
    expect(config.addressPrefix).toBe('manifest');
    expect(config.keyfilePath).toContain('.manifest');
    expect(config.keyfilePath).toContain('key.json');
  });
});

describe('loadKeyfileConfig — keyPassword (PR #176 review)', () => {
  it('surfaces MANIFEST_KEY_PASSWORD so `export` has a byte-preserving source', async () => {
    // `export` exists to recover a keyfile encrypted under a pre-ENG-668
    // password that absorbed a paste's trailing CR/LF. Those bytes cannot be
    // typed at the prompt, which treats CR and LF as submission -- so without
    // this passthrough the command could not open the very keyfiles it is for.
    const corrupted = `hunter2${String.fromCharCode(13)}${String.fromCharCode(10)}`;
    process.env.MANIFEST_KEY_PASSWORD = corrupted;

    const { loadKeyfileConfig } = await import('./config.js');

    expect(loadKeyfileConfig().keyPassword).toBe(corrupted);
  });

  it('leaves keyPassword undefined when the variable is unset', async () => {
    const { loadKeyfileConfig } = await import('./config.js');

    expect(loadKeyfileConfig().keyPassword).toBeUndefined();
  });
});
