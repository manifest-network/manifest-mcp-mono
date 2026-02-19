import dotenv from 'dotenv';

dotenv.config();

export interface NodeMCPConfig {
  readonly chainId: string;
  readonly rpcUrl: string;
  readonly gasPrice: string;
  readonly addressPrefix: string;
  readonly mnemonic: string;
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
  return process.env[key] || defaultValue;
}

export function loadConfig(): NodeMCPConfig {
  return {
    chainId: getEnvRequired('COSMOS_CHAIN_ID'),
    rpcUrl: getEnvRequired('COSMOS_RPC_URL'),
    gasPrice: getEnvRequired('COSMOS_GAS_PRICE'),
    addressPrefix: getEnvOptional('COSMOS_ADDRESS_PREFIX', 'manifest'),
    mnemonic: getEnvRequired('COSMOS_MNEMONIC'),
  };
}
