import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export interface NodeMCPConfig {
  readonly chainId: string;
  readonly rpcUrl: string;
  readonly gasPrice: string;
  readonly addressPrefix: string;
  readonly mnemonic?: string;
  readonly keyfilePath: string;
  readonly keyPassword?: string;
}

function getEnvRequired(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Environment variable ${key} is not set. Please check your .env file or environment.`
    );
  }
  return value;
}

function getEnvOptional(key: string, defaultValue: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') return defaultValue;
  return value;
}

function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function loadKeyfileConfig(): Pick<NodeMCPConfig, 'addressPrefix' | 'keyfilePath'> {
  return {
    addressPrefix: getEnvOptional('COSMOS_ADDRESS_PREFIX', 'manifest'),
    keyfilePath: resolvePath(getEnvOptional('MANIFEST_KEY_FILE', join(homedir(), '.manifest', 'key.json'))),
  };
}

export function loadConfig(): NodeMCPConfig {
  return {
    chainId: getEnvRequired('COSMOS_CHAIN_ID'),
    rpcUrl: getEnvRequired('COSMOS_RPC_URL'),
    gasPrice: getEnvRequired('COSMOS_GAS_PRICE'),
    addressPrefix: getEnvOptional('COSMOS_ADDRESS_PREFIX', 'manifest'),
    mnemonic: process.env['COSMOS_MNEMONIC'],
    keyfilePath: resolvePath(getEnvOptional('MANIFEST_KEY_FILE', join(homedir(), '.manifest', 'key.json'))),
    keyPassword: process.env['MANIFEST_KEY_PASSWORD'],
  };
}
