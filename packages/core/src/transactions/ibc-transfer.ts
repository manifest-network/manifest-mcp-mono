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
      const [sourcePortRaw, sourceChannelRaw, receiverRaw, amountStr] =
        positionalArgs;
      const { amount, denom } = parseAmount(amountStr);

      // Source port/channel are on this chain — fail loudly when blank, and
      // forward trimmed values so stray whitespace doesn't reach the chain.
      // Receiver is on the destination chain; we don't validate its bech32
      // prefix because the destination chain may use a different address
      // format, but we still trim incidental whitespace.
      const sourcePort = sourcePortRaw?.trim() ?? '';
      const sourceChannel = sourceChannelRaw?.trim() ?? '';
      const receiver = receiverRaw?.trim() ?? '';
      if (!sourcePort) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'ibc-transfer transfer: source-port is required',
        );
      }
      if (!sourceChannel) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'ibc-transfer transfer: source-channel is required',
        );
      }
      if (!receiver) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'ibc-transfer transfer: receiver is required',
        );
      }

      const memo = memoFlag.value ?? '';
      if (memo) {
        validateMemo(memo);
      }

      // timeout-height parsed as exactly "<revisionNumber>-<revisionHeight>".
      // Strict 2-part split: rejects "1-2-3" (would silently drop the trailing
      // "-3" if we just destructured) and other malformed shapes.
      let timeoutHeight = {
        revisionNumber: BigInt(0),
        revisionHeight: BigInt(0),
      };
      if (timeoutHeightFlag.value) {
        const parts = timeoutHeightFlag.value.split('-');
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Invalid --timeout-height "${timeoutHeightFlag.value}". Expected "<revision-number>-<revision-height>".`,
          );
        }
        const [numStr, heightStr] = parts;
        // Note: negative values cannot reach parseBigInt here because `-` is
        // the field separator — `-1-1000` splits to 3 parts and is rejected
        // by the length check above.
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
        if (timeoutTimestamp < BigInt(0)) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            'timeout-timestamp must be non-negative',
          );
        }
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
