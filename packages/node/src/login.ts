import { loadLoginConfig } from './config.js';
import {
  runOAuthFlow,
  extractPrivateKey,
  saveSession,
  getSessionPath,
  Web3AuthWalletProvider,
} from './web3auth/index.js';

export async function runLogin(): Promise<void> {
  const { oauthConfig, web3authConfig, addressPrefix } = loadLoginConfig();

  console.error('Starting OAuth login flow...');
  const { idToken, verifierId } = await runOAuthFlow(oauthConfig);
  console.error(`Authenticated as ${verifierId}`);

  console.error('Deriving wallet key via Web3Auth...');
  const privateKeyHex = await extractPrivateKey(web3authConfig, idToken, verifierId);

  const walletProvider = new Web3AuthWalletProvider(privateKeyHex, addressPrefix);
  await walletProvider.connect();
  const address = await walletProvider.getAddress();
  await walletProvider.disconnect();

  saveSession({
    idToken,
    oauthProvider: oauthConfig.provider,
    verifierId,
    createdAt: new Date().toISOString(),
    privateKeyHex,
    address,
  });

  console.error(`Session saved to ${getSessionPath()}`);
  console.error(`Address: ${address}`);
}
