import type { SigningStargateClient } from '@cosmjs/stargate';
import { cosmos } from '@manifest-network/manifestjs';
import { throwUnsupportedSubcommand } from '../modules.js';
import type { BuiltMessages, CosmosTxResult, TxOptions } from '../types.js';
import {
  buildGasFee,
  buildTxResult,
  parseAmount,
  requireArgs,
  validateAddress,
  validateArgsLength,
} from './utils.js';

const { MsgDelegate, MsgUndelegate, MsgBeginRedelegate } =
  cosmos.staking.v1beta1;

/**
 * Build messages for a staking transaction subcommand (no signing/broadcasting).
 */
export function buildStakingMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
): BuiltMessages {
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

      return { messages: [msg], memo: '' };
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

      return { messages: [msg], memo: '', canonicalSubcommand: 'unbond' };
    }

    case 'redelegate': {
      requireArgs(
        args,
        3,
        ['src-validator', 'dst-validator', 'amount'],
        'staking redelegate',
      );
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

      return { messages: [msg], memo: '' };
    }

    default:
      throwUnsupportedSubcommand('tx', 'staking', subcommand);
  }
}

/**
 * Route staking transaction to appropriate handler
 */
export async function routeStakingTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  const built = buildStakingMessages(senderAddress, subcommand, args);
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
    'staking',
    built.canonicalSubcommand ?? subcommand,
    result,
    waitForConfirmation,
  );
}
