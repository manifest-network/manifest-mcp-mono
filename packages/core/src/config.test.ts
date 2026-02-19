import { describe, it, expect } from 'vitest';
import { createConfig, validateConfig, createValidatedConfig } from './config.js';
import { ManifestMCPError, ManifestMCPErrorCode } from './types.js';

describe('createConfig', () => {
  it('should apply default values', () => {
    const config = createConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
    });

    expect(config.chainId).toBe('test-chain');
    expect(config.rpcUrl).toBe('https://example.com');
    expect(config.gasPrice).toBe('1.0umfx');
    expect(config.addressPrefix).toBe('manifest');
  });

  it('should preserve provided optional values', () => {
    const config = createConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      addressPrefix: 'custom',
    });

    expect(config.addressPrefix).toBe('custom');
  });

  it('should apply default rateLimit', () => {
    const config = createConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
    });

    expect(config.rateLimit).toBeDefined();
    expect(config.rateLimit?.requestsPerSecond).toBe(10);
  });

  it('should preserve provided rateLimit', () => {
    const config = createConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      rateLimit: { requestsPerSecond: 20 },
    });

    expect(config.rateLimit?.requestsPerSecond).toBe(20);
  });
});

describe('validateConfig', () => {
  it('should return valid for correct config', () => {
    const result = validateConfig({
      chainId: 'manifest-testnet',
      rpcUrl: 'https://rpc.example.com',
      gasPrice: '1.0umfx',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should detect missing required fields', () => {
    const result = validateConfig({});

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('chainId is required');
    expect(result.errors).toContain('rpcUrl is required');
    expect(result.errors).toContain('gasPrice is required');
  });

  it('should validate chainId format', () => {
    const result = validateConfig({
      chainId: '-invalid',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('chainId'))).toBe(true);
  });

  it('should validate rpcUrl format', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'not-a-url',
      gasPrice: '1.0umfx',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rpcUrl'))).toBe(true);
  });

  it('should validate gasPrice format', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: 'invalid',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('gasPrice'))).toBe(true);
  });

  it('should validate optional addressPrefix', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      addressPrefix: 'INVALID',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('addressPrefix'))).toBe(true);
  });

  it('should accept HTTPS URLs', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://rpc.example.com',
      gasPrice: '1.0umfx',
    });

    expect(result.valid).toBe(true);
  });

  it('should accept HTTP URLs for localhost', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'http://localhost:26657',
      gasPrice: '1.0umfx',
    });

    expect(result.valid).toBe(true);
  });

  it('should accept HTTP URLs for 127.0.0.1', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'http://127.0.0.1:26657',
      gasPrice: '1.0umfx',
    });

    expect(result.valid).toBe(true);
  });

  it('should accept HTTP URLs for IPv6 localhost', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'http://[::1]:26657',
      gasPrice: '1.0umfx',
    });

    expect(result.valid).toBe(true);
  });

  it('should reject HTTP URLs for non-localhost', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'http://rpc.example.com',
      gasPrice: '1.0umfx',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('HTTPS'))).toBe(true);
  });

  it('should accept valid rateLimit config', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      rateLimit: { requestsPerSecond: 5 },
    });

    expect(result.valid).toBe(true);
  });

  it('should reject non-integer rateLimit.requestsPerSecond', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      rateLimit: { requestsPerSecond: 5.5 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('requestsPerSecond'))).toBe(true);
  });

  it('should reject negative rateLimit.requestsPerSecond', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      rateLimit: { requestsPerSecond: -1 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('requestsPerSecond'))).toBe(true);
  });

  it('should reject zero rateLimit.requestsPerSecond', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      rateLimit: { requestsPerSecond: 0 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('requestsPerSecond'))).toBe(true);
  });

  it('should reject null rateLimit', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      rateLimit: null as unknown as { requestsPerSecond?: number },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rateLimit must be a plain object'))).toBe(true);
  });

  it('should reject non-object rateLimit', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      rateLimit: 'invalid' as unknown as { requestsPerSecond?: number },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rateLimit must be a plain object'))).toBe(true);
  });

  it('should reject array rateLimit', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      rateLimit: [] as unknown as { requestsPerSecond?: number },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('rateLimit must be a plain object'))).toBe(true);
  });
});

describe('createValidatedConfig', () => {
  it('should return config for valid input', () => {
    const config = createValidatedConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
    });

    expect(config.chainId).toBe('test-chain');
  });

  it('should throw ManifestMCPError for invalid input', () => {
    expect(() => createValidatedConfig({
      chainId: '',
      rpcUrl: '',
      gasPrice: '',
    })).toThrow(ManifestMCPError);
  });

  it('should have INVALID_CONFIG error code', () => {
    try {
      createValidatedConfig({
        chainId: '',
        rpcUrl: '',
        gasPrice: '',
      });
    } catch (error) {
      expect((error as ManifestMCPError).code).toBe(ManifestMCPErrorCode.INVALID_CONFIG);
    }
  });

  it('should apply default retry config', () => {
    const config = createValidatedConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
    });

    expect(config.retry).toBeDefined();
    expect(config.retry?.maxRetries).toBe(3);
    expect(config.retry?.baseDelayMs).toBe(1000);
    expect(config.retry?.maxDelayMs).toBe(10000);
  });

  it('should preserve provided retry config', () => {
    const config = createValidatedConfig({
      chainId: 'test-chain',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 5000 },
    });

    expect(config.retry?.maxRetries).toBe(5);
    expect(config.retry?.baseDelayMs).toBe(500);
    expect(config.retry?.maxDelayMs).toBe(5000);
  });
});

describe('validateConfig retry options', () => {
  it('should accept valid retry config', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { maxRetries: 5, baseDelayMs: 500, maxDelayMs: 5000 },
    });

    expect(result.valid).toBe(true);
  });

  it('should accept retry config with maxRetries: 0', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { maxRetries: 0 },
    });

    expect(result.valid).toBe(true);
  });

  it('should reject non-object retry config', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: 'invalid' as unknown as { maxRetries?: number },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('retry must be a plain object'))).toBe(true);
  });

  it('should reject null retry config', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: null as unknown as { maxRetries?: number },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('retry must be a plain object'))).toBe(true);
  });

  it('should reject negative maxRetries', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { maxRetries: -1 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('maxRetries'))).toBe(true);
  });

  it('should reject non-integer maxRetries', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { maxRetries: 2.5 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('maxRetries'))).toBe(true);
  });

  it('should reject zero baseDelayMs', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { baseDelayMs: 0 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('baseDelayMs'))).toBe(true);
  });

  it('should reject negative baseDelayMs', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { baseDelayMs: -100 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('baseDelayMs'))).toBe(true);
  });

  it('should reject zero maxDelayMs', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { maxDelayMs: 0 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('maxDelayMs'))).toBe(true);
  });

  it('should reject maxDelayMs less than baseDelayMs', () => {
    const result = validateConfig({
      chainId: 'test',
      rpcUrl: 'https://example.com',
      gasPrice: '1.0umfx',
      retry: { baseDelayMs: 1000, maxDelayMs: 500 },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('maxDelayMs must be greater than or equal to'))).toBe(true);
  });
});
