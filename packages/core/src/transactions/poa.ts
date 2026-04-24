import { fromBech32 } from '@cosmjs/encoding';
import type { SigningStargateClient } from '@cosmjs/stargate';
import { strangelove_ventures as strangeloveVenturesNs } from '@manifest-network/manifestjs';
import { throwUnsupportedSubcommand } from '../modules.js';
import {
  type BuiltMessages,
  type CosmosTxResult,
  ManifestMCPError,
  ManifestMCPErrorCode,
  type TxOptions,
} from '../types.js';
import {
  buildGasFee,
  buildTxResult,
  extractBooleanFlag,
  parseBigInt,
  requireArgs,
  validateAddress,
  validateArgsLength,
} from './utils.js';

const {
  MsgSetPower,
  MsgRemoveValidator,
  MsgRemovePending,
  MsgUpdateStakingParams,
  MsgCreateValidator,
} = strangeloveVenturesNs.poa.v1;

function parseJsonMsg<T>(input: string, context: string): T {
  try {
    return JSON.parse(input) as T;
  } catch (error) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `${context}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Build messages for a PoA transaction subcommand (no signing/broadcasting).
 *
 * Sender is set to the configured wallet address. For governance-authority-only
 * messages (`update-staking-params`, `remove-validator`), the sender must match
 * the configured PoA authority; the chain rejects the tx otherwise.
 */
export function buildPoAMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
): BuiltMessages {
  validateArgsLength(args, 'poa transaction');

  // Derive the operator address prefix from the sender (e.g. "manifest" ->
  // "manifestvaloper"). PoA validator targets must be valoper-prefixed; a
  // wallet-prefixed address (easy mistake) would pass bech32 validation and
  // only fail at broadcast with an opaque chain error.
  const valoperPrefix = `${fromBech32(senderAddress).prefix}valoper`;

  switch (subcommand) {
    case 'set-power': {
      const { value: unsafe, remainingArgs } = extractBooleanFlag(
        args,
        '--unsafe',
      );
      requireArgs(
        remainingArgs,
        2,
        ['validator-address', 'power'],
        'poa set-power',
      );
      const [validatorAddress, powerStr] = remainingArgs;
      validateAddress(validatorAddress, 'validator address', valoperPrefix);
      const power = parseBigInt(powerStr, 'power');

      const msg = {
        typeUrl: '/strangelove_ventures.poa.v1.MsgSetPower',
        value: MsgSetPower.fromPartial({
          sender: senderAddress,
          validatorAddress,
          power,
          unsafe,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'remove-validator': {
      requireArgs(args, 1, ['validator-address'], 'poa remove-validator');
      const [validatorAddress] = args;
      validateAddress(validatorAddress, 'validator address', valoperPrefix);

      const msg = {
        typeUrl: '/strangelove_ventures.poa.v1.MsgRemoveValidator',
        value: MsgRemoveValidator.fromPartial({
          sender: senderAddress,
          validatorAddress,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'remove-pending': {
      requireArgs(args, 1, ['validator-address'], 'poa remove-pending');
      const [validatorAddress] = args;
      validateAddress(validatorAddress, 'validator address', valoperPrefix);

      const msg = {
        typeUrl: '/strangelove_ventures.poa.v1.MsgRemovePending',
        value: MsgRemovePending.fromPartial({
          sender: senderAddress,
          validatorAddress,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'update-staking-params': {
      requireArgs(args, 1, ['params-json'], 'poa update-staking-params');
      const params = parseJsonMsg<unknown>(
        args[0],
        'poa update-staking-params params-json',
      );

      const msg = {
        typeUrl: '/strangelove_ventures.poa.v1.MsgUpdateStakingParams',
        value: MsgUpdateStakingParams.fromPartial({
          sender: senderAddress,
          params: params as Parameters<
            typeof MsgUpdateStakingParams.fromPartial
          >[0]['params'],
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'create-validator': {
      // Accepts the full MsgCreateValidator body as JSON. Sender's delegator/validator
      // address defaults to the wallet address when omitted in the JSON.
      requireArgs(args, 1, ['msg-json'], 'poa create-validator');
      const body = parseJsonMsg<Record<string, unknown>>(
        args[0],
        'poa create-validator msg-json',
      );

      const msg = {
        typeUrl: '/strangelove_ventures.poa.v1.MsgCreateValidator',
        value: MsgCreateValidator.fromPartial({
          delegatorAddress:
            (body.delegatorAddress as string | undefined) ?? senderAddress,
          validatorAddress:
            (body.validatorAddress as string | undefined) ?? senderAddress,
          ...body,
        } as Parameters<typeof MsgCreateValidator.fromPartial>[0]),
      };
      return { messages: [msg], memo: '' };
    }

    default:
      throwUnsupportedSubcommand('tx', 'poa', subcommand);
  }
}

/**
 * Route PoA transaction to appropriate handler
 */
export async function routePoATransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  const built = buildPoAMessages(senderAddress, subcommand, args);
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
    'poa',
    built.canonicalSubcommand ?? subcommand,
    result,
    waitForConfirmation,
  );
}
