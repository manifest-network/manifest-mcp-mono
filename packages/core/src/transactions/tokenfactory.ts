import type { SigningStargateClient } from '@cosmjs/stargate';
import { osmosis as osmosisNs } from '@manifest-network/manifestjs';
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
  parseAmount,
  requireArgs,
  validateAddress,
  validateArgsLength,
} from './utils.js';

const {
  MsgCreateDenom,
  MsgMint,
  MsgBurn,
  MsgChangeAdmin,
  MsgSetDenomMetadata,
  MsgForceTransfer,
  MsgUpdateParams,
} = osmosisNs.tokenfactory.v1beta1;

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
 * Build messages for a tokenfactory (osmosis) transaction subcommand.
 */
export function buildTokenfactoryMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
): BuiltMessages {
  validateArgsLength(args, 'tokenfactory transaction');

  switch (subcommand) {
    case 'create-denom': {
      requireArgs(args, 1, ['subdenom'], 'tokenfactory create-denom');
      const [subdenom] = args;

      const msg = {
        typeUrl: '/osmosis.tokenfactory.v1beta1.MsgCreateDenom',
        value: MsgCreateDenom.fromPartial({
          sender: senderAddress,
          subdenom,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'mint': {
      requireArgs(args, 2, ['amount', 'mint-to-address'], 'tokenfactory mint');
      const [amountStr, mintToAddress] = args;
      validateAddress(mintToAddress, 'mint-to address');
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/osmosis.tokenfactory.v1beta1.MsgMint',
        value: MsgMint.fromPartial({
          sender: senderAddress,
          amount: { denom, amount },
          mintToAddress,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'burn': {
      requireArgs(
        args,
        2,
        ['amount', 'burn-from-address'],
        'tokenfactory burn',
      );
      const [amountStr, burnFromAddress] = args;
      validateAddress(burnFromAddress, 'burn-from address');
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/osmosis.tokenfactory.v1beta1.MsgBurn',
        value: MsgBurn.fromPartial({
          sender: senderAddress,
          amount: { denom, amount },
          burnFromAddress,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'change-admin': {
      requireArgs(args, 2, ['denom', 'new-admin'], 'tokenfactory change-admin');
      const [denom, newAdmin] = args;
      validateAddress(newAdmin, 'new admin address');

      const msg = {
        typeUrl: '/osmosis.tokenfactory.v1beta1.MsgChangeAdmin',
        value: MsgChangeAdmin.fromPartial({
          sender: senderAddress,
          denom,
          newAdmin,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'set-denom-metadata': {
      requireArgs(
        args,
        1,
        ['metadata-json'],
        'tokenfactory set-denom-metadata',
      );
      const metadata = parseJsonMsg<unknown>(
        args[0],
        'tokenfactory set-denom-metadata metadata-json',
      );

      const msg = {
        typeUrl: '/osmosis.tokenfactory.v1beta1.MsgSetDenomMetadata',
        value: MsgSetDenomMetadata.fromPartial({
          sender: senderAddress,
          metadata: metadata as Parameters<
            typeof MsgSetDenomMetadata.fromPartial
          >[0]['metadata'],
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'force-transfer': {
      requireArgs(
        args,
        3,
        ['amount', 'from-address', 'to-address'],
        'tokenfactory force-transfer',
      );
      const [amountStr, transferFromAddress, transferToAddress] = args;
      validateAddress(transferFromAddress, 'transfer-from address');
      validateAddress(transferToAddress, 'transfer-to address');
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/osmosis.tokenfactory.v1beta1.MsgForceTransfer',
        value: MsgForceTransfer.fromPartial({
          sender: senderAddress,
          amount: { denom, amount },
          transferFromAddress,
          transferToAddress,
        }),
      };
      return { messages: [msg], memo: '' };
    }

    case 'update-params': {
      requireArgs(args, 1, ['params-json'], 'tokenfactory update-params');
      const params = parseJsonMsg<unknown>(
        args[0],
        'tokenfactory update-params params-json',
      );

      const msg = {
        typeUrl: '/osmosis.tokenfactory.v1beta1.MsgUpdateParams',
        value: MsgUpdateParams.fromPartial({
          authority: senderAddress,
          params: params as Parameters<
            typeof MsgUpdateParams.fromPartial
          >[0]['params'],
        }),
      };
      return { messages: [msg], memo: '' };
    }

    default:
      throwUnsupportedSubcommand('tx', 'tokenfactory', subcommand);
  }
}

/**
 * Route tokenfactory transaction to appropriate handler
 */
export async function routeTokenfactoryTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  const built = buildTokenfactoryMessages(senderAddress, subcommand, args);
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
    'tokenfactory',
    built.canonicalSubcommand ?? subcommand,
    result,
    waitForConfirmation,
  );
}
