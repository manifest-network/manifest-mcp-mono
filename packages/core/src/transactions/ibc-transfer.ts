import type { SigningStargateClient } from '@cosmjs/stargate';
import { ibc as ibcNs } from '@manifest-network/manifestjs';
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
  extractFlag,
  filterConsumedArgs,
  parseAmount,
  parseBigInt,
  requireArgs,
  validateAddress,
  validateArgsLength,
  validateMemo,
} from './utils.js';

const { MsgTransfer } = ibcNs.applications.transfer.v1;

/** Default timeout: 10 minutes from now (in nanoseconds). */
const DEFAULT_TIMEOUT_NS = BigInt(10 * 60) * BigInt(1_000_000_000);

/**
 * Build messages for an IBC transfer transaction subcommand.
 */
export function buildIbcTransferMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
): BuiltMessages {
  validateArgsLength(args, 'ibc-transfer transaction');

  switch (subcommand) {
    case 'transfer': {
      // Extract optional flags first.
      const memoFlag = extractFlag(args, '--memo', 'ibc-transfer transfer');
      const timeoutHeightFlag = extractFlag(
        args,
        '--timeout-height',
        'ibc-transfer transfer',
      );
      const timeoutTimestampFlag = extractFlag(
        args,
        '--timeout-timestamp',
        'ibc-transfer transfer',
      );
      const consumed = [
        ...memoFlag.consumedIndices,
        ...timeoutHeightFlag.consumedIndices,
        ...timeoutTimestampFlag.consumedIndices,
      ];
      const positionalArgs = filterConsumedArgs(args, consumed);

      requireArgs(
        positionalArgs,
        4,
        ['source-port', 'source-channel', 'receiver', 'amount'],
        'ibc-transfer transfer',
      );
      const [sourcePort, sourceChannel, receiver, amountStr] = positionalArgs;
      const { amount, denom } = parseAmount(amountStr);

      // Receiver is on the destination chain; we don't validate the bech32
      // prefix here because it may follow the destination's address format.
      if (!receiver || receiver.trim() === '') {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'ibc-transfer transfer: receiver is required',
        );
      }

      const memo = memoFlag.value ?? '';
      if (memo) {
        validateMemo(memo);
      }

      // timeout-height parsed as "<revisionNumber>-<revisionHeight>"
      let timeoutHeight = {
        revisionNumber: BigInt(0),
        revisionHeight: BigInt(0),
      };
      if (timeoutHeightFlag.value) {
        const [numStr, heightStr] = timeoutHeightFlag.value.split('-');
        if (!numStr || !heightStr) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Invalid --timeout-height "${timeoutHeightFlag.value}". Expected "<revision-number>-<revision-height>".`,
          );
        }
        timeoutHeight = {
          revisionNumber: parseBigInt(numStr, 'timeout-height revision-number'),
          revisionHeight: parseBigInt(
            heightStr,
            'timeout-height revision-height',
          ),
        };
      }

      // timeout-timestamp is a nanosecond epoch timestamp; default to now + 10 min.
      let timeoutTimestamp: bigint;
      if (timeoutTimestampFlag.value) {
        timeoutTimestamp = parseBigInt(
          timeoutTimestampFlag.value,
          'timeout-timestamp',
        );
      } else if (
        timeoutHeight.revisionNumber === BigInt(0) &&
        timeoutHeight.revisionHeight === BigInt(0)
      ) {
        timeoutTimestamp =
          BigInt(Date.now()) * BigInt(1_000_000) + DEFAULT_TIMEOUT_NS;
      } else {
        timeoutTimestamp = BigInt(0);
      }

      validateAddress(senderAddress, 'sender address');

      const msg = {
        typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
        value: MsgTransfer.fromPartial({
          sourcePort,
          sourceChannel,
          token: { denom, amount },
          sender: senderAddress,
          receiver,
          timeoutHeight,
          timeoutTimestamp,
        }),
      };
      return { messages: [msg], memo };
    }

    default:
      throwUnsupportedSubcommand('tx', 'ibc-transfer', subcommand);
  }
}

/**
 * Route IBC transfer transaction to appropriate handler
 */
export async function routeIbcTransferTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  const built = buildIbcTransferMessages(senderAddress, subcommand, args);
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
    'ibc-transfer',
    built.canonicalSubcommand ?? subcommand,
    result,
    waitForConfirmation,
  );
}
