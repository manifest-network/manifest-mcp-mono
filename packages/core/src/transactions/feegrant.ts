import type { SigningStargateClient } from '@cosmjs/stargate';
import { cosmos } from '@manifest-network/manifestjs';
import { throwUnsupportedSubcommand } from '../modules.js';
import type { BuiltMessages, CosmosTxResult, TxOptions } from '../types.js';
import {
  buildGasFee,
  buildTxResult,
  extractFlag,
  filterConsumedArgs,
  parseAmount,
  parseUnixSecondsToDate,
  requireArgs,
  validateAddress,
  validateArgsLength,
} from './utils.js';

const { MsgGrantAllowance, MsgRevokeAllowance, MsgPruneAllowances } =
  cosmos.feegrant.v1beta1;

const BASIC_ALLOWANCE_TYPE_URL = '/cosmos.feegrant.v1beta1.BasicAllowance';

/**
 * Build messages for a feegrant transaction subcommand (no signing/broadcasting).
 */
export function buildFeegrantMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
): BuiltMessages {
  validateArgsLength(args, 'feegrant transaction');

  switch (subcommand) {
    case 'grant-allowance': {
      const spendLimitFlag = extractFlag(
        args,
        '--spend-limit',
        'feegrant grant-allowance',
      );
      const expirationFlag = extractFlag(
        args,
        '--expiration',
        'feegrant grant-allowance',
      );
      const positionalArgs = filterConsumedArgs(args, [
        ...spendLimitFlag.consumedIndices,
        ...expirationFlag.consumedIndices,
      ]);
      requireArgs(
        positionalArgs,
        1,
        ['grantee-address'],
        'feegrant grant-allowance',
      );
      const [granteeAddress] = positionalArgs;
      validateAddress(granteeAddress, 'grantee address');

      const spendLimit = spendLimitFlag.value
        ? [parseAmount(spendLimitFlag.value)]
        : [];

      const expiration = expirationFlag.value
        ? parseUnixSecondsToDate(expirationFlag.value, 'expiration')
        : undefined;

      const msg = {
        typeUrl: '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
        value: MsgGrantAllowance.fromPartial({
          granter: senderAddress,
          grantee: granteeAddress,
          allowance: {
            $typeUrl: BASIC_ALLOWANCE_TYPE_URL,
            spendLimit,
            expiration,
          },
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'revoke-allowance': {
      requireArgs(args, 1, ['grantee-address'], 'feegrant revoke-allowance');
      const [granteeAddress] = args;
      validateAddress(granteeAddress, 'grantee address');

      const msg = {
        typeUrl: '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
        value: MsgRevokeAllowance.fromPartial({
          granter: senderAddress,
          grantee: granteeAddress,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'prune-allowances': {
      const msg = {
        typeUrl: '/cosmos.feegrant.v1beta1.MsgPruneAllowances',
        value: MsgPruneAllowances.fromPartial({
          pruner: senderAddress,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    default:
      throwUnsupportedSubcommand('tx', 'feegrant', subcommand);
  }
}

/**
 * Route feegrant transaction to appropriate handler
 */
export async function routeFeegrantTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  const built = buildFeegrantMessages(senderAddress, subcommand, args);
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
    'feegrant',
    built.canonicalSubcommand ?? subcommand,
    result,
    waitForConfirmation,
  );
}
