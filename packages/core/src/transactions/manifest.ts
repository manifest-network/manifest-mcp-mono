import type { SigningStargateClient } from '@cosmjs/stargate';
import { liftedinit } from '@manifest-network/manifestjs';
import { throwUnsupportedSubcommand } from '../modules.js';
import type { BuiltMessages, CosmosTxResult, TxOptions } from '../types.js';
import {
  buildGasFee,
  buildTxResult,
  parseAmount,
  parseColonPair,
  requireArgs,
  validateAddress,
  validateArgsLength,
} from './utils.js';

const { MsgPayout, MsgBurnHeldBalance } = liftedinit.manifest.v1;

/**
 * Build messages for a manifest transaction subcommand (no signing/broadcasting).
 */
export function buildManifestMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
): BuiltMessages {
  validateArgsLength(args, 'manifest transaction');

  switch (subcommand) {
    case 'payout': {
      requireArgs(args, 1, ['address:amount'], 'manifest payout');
      // Parse payout pairs (format: address:amount ...)
      const payoutPairs = args.map((arg) => {
        const [address, amountStr] = parseColonPair(
          arg,
          'address',
          'amount',
          'payout pair',
        );
        validateAddress(address, 'payout recipient address');
        const { amount, denom } = parseAmount(amountStr);
        return { address, coin: { denom, amount } };
      });

      const msg = {
        typeUrl: '/liftedinit.manifest.v1.MsgPayout',
        value: MsgPayout.fromPartial({
          authority: senderAddress,
          payoutPairs,
        }),
      };

      return { messages: [msg], memo: '' };
    }

    case 'burn-held-balance': {
      requireArgs(args, 1, ['amount'], 'manifest burn-held-balance');
      // Parse coins to burn
      const burnCoins = args.map((amountStr) => {
        const { amount, denom } = parseAmount(amountStr);
        return { denom, amount };
      });

      const msg = {
        typeUrl: '/liftedinit.manifest.v1.MsgBurnHeldBalance',
        value: MsgBurnHeldBalance.fromPartial({
          authority: senderAddress,
          burnCoins,
        }),
      };

      return { messages: [msg], memo: '' };
    }

    default:
      throwUnsupportedSubcommand('tx', 'manifest', subcommand);
  }
}

/**
 * Route manifest transaction to appropriate handler
 */
export async function routeManifestTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  const built = buildManifestMessages(senderAddress, subcommand, args);
  const fee = await buildGasFee(
    client,
    senderAddress,
    built.messages,
    options,
    built.memo,
  );
  const result = await client.signAndBroadcast(
    senderAddress,
    built.messages,
    fee,
    built.memo,
  );
  return buildTxResult(
    'manifest',
    built.canonicalSubcommand ?? subcommand,
    result,
    waitForConfirmation,
  );
}
