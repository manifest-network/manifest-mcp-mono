import type { Secp256k1HdWallet } from '@cosmjs/amino';
import { toBase64 } from '@cosmjs/encoding';
import {
  ManifestMCPError,
  ManifestMCPErrorCode,
  type SignArbitraryResult,
} from '../types.js';

/**
 * Sign arbitrary data using ADR-036 amino sign doc.
 * Shared implementation used by both MnemonicWalletProvider and KeyfileWalletProvider.
 */
export async function signArbitraryWithAmino(
  aminoWallet: Secp256k1HdWallet,
  walletAddress: string,
  address: string,
  data: string,
): Promise<SignArbitraryResult> {
  if (address !== walletAddress) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.INVALID_ADDRESS,
      `Cannot sign for address "${address}": wallet address is "${walletAddress}"`,
    );
  }

  const signDoc = {
    chain_id: '',
    account_number: '0',
    sequence: '0',
    fee: { gas: '0', amount: [] },
    msgs: [
      {
        type: 'sign/MsgSignData',
        value: {
          signer: address,
          data: toBase64(new TextEncoder().encode(data)),
        },
      },
    ],
    memo: '',
  };

  const { signature } = await aminoWallet.signAmino(address, signDoc);
  return {
    pub_key: signature.pub_key,
    signature: signature.signature,
  };
}
