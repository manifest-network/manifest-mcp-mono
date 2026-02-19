import { SigningStargateClient } from '@cosmjs/stargate';
import { cosmos } from '@manifest-network/manifestjs';
import { CosmosTxResult } from '../types.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import { parseAmount, buildTxResult, validateAddress, validateMemo, validateArgsLength, extractFlag, filterConsumedArgs, parseColonPair, requireArgs } from './utils.js';

const { MsgSend, MsgMultiSend } = cosmos.bank.v1beta1;

/**
 * Route bank transaction to appropriate handler
 */
export async function routeBankTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean
): Promise<CosmosTxResult> {
  validateArgsLength(args, 'bank transaction');

  switch (subcommand) {
    case 'send': {
      // Extract optional flags before positional args
      const memoFlag = extractFlag(args, '--memo', 'bank send');
      const positionalArgs = filterConsumedArgs(args, memoFlag.consumedIndices);

      requireArgs(positionalArgs, 2, ['recipient-address', 'amount'], 'bank send');
      const [recipientAddress, amountStr] = positionalArgs;
      validateAddress(recipientAddress, 'recipient address');
      const { amount, denom } = parseAmount(amountStr);
      const memo = memoFlag.value ?? '';
      if (memo) {
        validateMemo(memo);
      }

      const msg = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: MsgSend.fromPartial({
          fromAddress: senderAddress,
          toAddress: recipientAddress,
          amount: [{ denom, amount }],
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto', memo);
      return buildTxResult('bank', 'send', result, waitForConfirmation);
    }

    case 'multi-send': {
      requireArgs(args, 1, ['recipient:amount'], 'bank multi-send');
      // Parse format: multi-send recipient1:amount1 recipient2:amount2 ...
      const outputs = args.map((arg) => {
        const [address, amountStr] = parseColonPair(arg, 'address', 'amount', 'multi-send');
        validateAddress(address, 'recipient address');
        const { amount, denom } = parseAmount(amountStr);
        return { address, coins: [{ denom, amount }] };
      });

      // Calculate total input
      const totalByDenom = new Map<string, bigint>();
      for (const output of outputs) {
        for (const coin of output.coins) {
          const current = totalByDenom.get(coin.denom) || BigInt(0);
          totalByDenom.set(coin.denom, current + BigInt(coin.amount));
        }
      }

      const inputCoins = Array.from(totalByDenom.entries()).map(([denom, amount]) => ({
        denom,
        amount: amount.toString(),
      }));

      const msg = {
        typeUrl: '/cosmos.bank.v1beta1.MsgMultiSend',
        value: MsgMultiSend.fromPartial({
          inputs: [{ address: senderAddress, coins: inputCoins }],
          outputs,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('bank', 'multi-send', result, waitForConfirmation);
    }

    default:
      throwUnsupportedSubcommand('tx', 'bank', subcommand);
  }
}
