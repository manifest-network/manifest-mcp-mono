import type { SigningStargateClient } from '@cosmjs/stargate';
import { cosmos } from '@manifest-network/manifestjs';
import { throwUnsupportedSubcommand } from '../modules.js';
import type { CosmosTxResult, TxOptions } from '../types.js';
import {
  buildGasFee,
  buildTxResult,
  parseAmount,
  requireArgs,
  validateAddress,
  validateArgsLength,
} from './utils.js';

const {
  MsgWithdrawDelegatorReward,
  MsgSetWithdrawAddress,
  MsgFundCommunityPool,
} = cosmos.distribution.v1beta1;

/**
 * Route distribution transaction to appropriate handler
 */
export async function routeDistributionTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  validateArgsLength(args, 'distribution transaction');

  switch (subcommand) {
    case 'withdraw-rewards': {
      requireArgs(
        args,
        1,
        ['validator-address'],
        'distribution withdraw-rewards',
      );
      const [validatorAddress] = args;
      validateAddress(validatorAddress, 'validator address');

      const msg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
        value: MsgWithdrawDelegatorReward.fromPartial({
          delegatorAddress: senderAddress,
          validatorAddress,
        }),
      };

      const fee = await buildGasFee(client, senderAddress, [msg], options);
      const result = await client.signAndBroadcast(senderAddress, [msg], fee);
      return buildTxResult(
        'distribution',
        'withdraw-rewards',
        result,
        waitForConfirmation,
      );
    }

    case 'set-withdraw-addr': {
      requireArgs(
        args,
        1,
        ['withdraw-address'],
        'distribution set-withdraw-addr',
      );
      const [withdrawAddress] = args;
      validateAddress(withdrawAddress, 'withdraw address');

      const msg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgSetWithdrawAddress',
        value: MsgSetWithdrawAddress.fromPartial({
          delegatorAddress: senderAddress,
          withdrawAddress,
        }),
      };

      const fee = await buildGasFee(client, senderAddress, [msg], options);
      const result = await client.signAndBroadcast(senderAddress, [msg], fee);
      return buildTxResult(
        'distribution',
        'set-withdraw-addr',
        result,
        waitForConfirmation,
      );
    }

    case 'fund-community-pool': {
      requireArgs(args, 1, ['amount'], 'distribution fund-community-pool');
      const [amountStr] = args;
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgFundCommunityPool',
        value: MsgFundCommunityPool.fromPartial({
          depositor: senderAddress,
          amount: [{ denom, amount }],
        }),
      };

      const fee = await buildGasFee(client, senderAddress, [msg], options);
      const result = await client.signAndBroadcast(senderAddress, [msg], fee);
      return buildTxResult(
        'distribution',
        'fund-community-pool',
        result,
        waitForConfirmation,
      );
    }

    default:
      throwUnsupportedSubcommand('tx', 'distribution', subcommand);
  }
}
