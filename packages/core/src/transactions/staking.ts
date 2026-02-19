import { SigningStargateClient } from '@cosmjs/stargate';
import { cosmos } from '@manifest-network/manifestjs';
import { CosmosTxResult } from '../types.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import { parseAmount, buildTxResult, validateAddress, validateArgsLength, requireArgs } from './utils.js';

const { MsgDelegate, MsgUndelegate, MsgBeginRedelegate } = cosmos.staking.v1beta1;

/**
 * Route staking transaction to appropriate handler
 */
export async function routeStakingTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean
): Promise<CosmosTxResult> {
  validateArgsLength(args, 'staking transaction');

  switch (subcommand) {
    case 'delegate': {
      requireArgs(args, 2, ['validator-address', 'amount'], 'staking delegate');
      const [validatorAddress, amountStr] = args;
      validateAddress(validatorAddress, 'validator address');
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
        value: MsgDelegate.fromPartial({
          delegatorAddress: senderAddress,
          validatorAddress,
          amount: { denom, amount },
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('staking', 'delegate', result, waitForConfirmation);
    }

    case 'unbond':
    case 'undelegate': {
      requireArgs(args, 2, ['validator-address', 'amount'], 'staking unbond');
      const [validatorAddress, amountStr] = args;
      validateAddress(validatorAddress, 'validator address');
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/cosmos.staking.v1beta1.MsgUndelegate',
        value: MsgUndelegate.fromPartial({
          delegatorAddress: senderAddress,
          validatorAddress,
          amount: { denom, amount },
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('staking', 'unbond', result, waitForConfirmation);
    }

    case 'redelegate': {
      requireArgs(args, 3, ['src-validator', 'dst-validator', 'amount'], 'staking redelegate');
      const [srcValidatorAddress, dstValidatorAddress, amountStr] = args;
      validateAddress(srcValidatorAddress, 'source validator address');
      validateAddress(dstValidatorAddress, 'destination validator address');
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/cosmos.staking.v1beta1.MsgBeginRedelegate',
        value: MsgBeginRedelegate.fromPartial({
          delegatorAddress: senderAddress,
          validatorSrcAddress: srcValidatorAddress,
          validatorDstAddress: dstValidatorAddress,
          amount: { denom, amount },
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('staking', 'redelegate', result, waitForConfirmation);
    }

    default:
      throwUnsupportedSubcommand('tx', 'staking', subcommand);
  }
}
