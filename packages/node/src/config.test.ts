import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homedir } from 'node:os';

// Mock dotenv so module-level config() is a no-op
vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  // Clear all env vars we set in tests
  delete process.env['COSMOS_CHAIN_ID'];
  delete process.env['COSMOS_RPC_URL'];
  delete process.env['COSMOS_GAS_PRICE'];
  delete process.env['COSMOS_ADDRESS_PREFIX'];
  delete process.env['COSMOS_MNEMONIC'];
  delete process.env['MANIFEST_KEY_FILE'];
  delete process.env['MANIFEST_KEY_PASSWORD'];
});

async function importConfig() {
  return import('./config.js');
}

describe('loadConfig', () => {
  it('should load required fields from env', async () => {
    process.env['COSMOS_CHAIN_ID'] = 'test-chain';
    process.env['COSMOS_RPC_URL'] = 'https://rpc.test.com';
    process.env['COSMOS_GAS_PRICE'] = '0.025umfx';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.chainId).toBe('test-chain');
    expect(config.rpcUrl).toBe('https://rpc.test.com');
    expect(config.gasPrice).toBe('0.025umfx');
  });

  it('should throw for missing COSMOS_CHAIN_ID', async () => {
    process.env['COSMOS_RPC_URL'] = 'https://rpc.test.com';
    process.env['COSMOS_GAS_PRICE'] = '0.025umfx';

    const { loadConfig } = await importConfig();
    expect(() => loadConfig()).toThrow(/COSMOS_CHAIN_ID/);
  });

  it('should default addressPrefix to "manifest"', async () => {
    process.env['COSMOS_CHAIN_ID'] = 'test-chain';
    process.env['COSMOS_RPC_URL'] = 'https://rpc.test.com';
    process.env['COSMOS_GAS_PRICE'] = '0.025umfx';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.addressPrefix).toBe('manifest');
  });

  it('should override addressPrefix from env', async () => {
    process.env['COSMOS_CHAIN_ID'] = 'test-chain';
    process.env['COSMOS_RPC_URL'] = 'https://rpc.test.com';
    process.env['COSMOS_GAS_PRICE'] = '0.025umfx';
    process.env['COSMOS_ADDRESS_PREFIX'] = 'cosmos';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.addressPrefix).toBe('cosmos');
  });

  it('should expand tilde in keyfilePath', async () => {
    process.env['COSMOS_CHAIN_ID'] = 'test-chain';
    process.env['COSMOS_RPC_URL'] = 'https://rpc.test.com';
    process.env['COSMOS_GAS_PRICE'] = '0.025umfx';
    process.env['MANIFEST_KEY_FILE'] = '~/my-key.json';

    const { loadConfig } = await importConfig();
    const config = loadConfig();
    expect(config.keyfilePath).toBe(`${homedir()}/my-key.json`);
    expect(config.keyfilePath).not.toContain('~');
  });

  it('should fall back to default when env var is empty string', async () => {
    process.env['COSMOS_CHAIN_ID'] = 'test-chain';
    process.env['COSMOS_RPC_URL'] = 'https://rpc.test.com';
    process.env['COSMOS_GAS_PRICE'] = '0.025umfx';
    process.env['COSMOS_ADDRESS_PREFIX'] = '';

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
