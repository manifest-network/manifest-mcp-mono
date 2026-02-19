import { SigningStargateClient } from '@cosmjs/stargate';
import { cosmos } from '@manifest-network/manifestjs';
import { ManifestMCPError, ManifestMCPErrorCode, CosmosTxResult } from '../types.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import { parseAmount, buildTxResult, parseBigInt, validateArgsLength, extractFlag, filterConsumedArgs, requireArgs, parseVoteOption } from './utils.js';

const { MsgVote, MsgDeposit, MsgVoteWeighted, VoteOption } = cosmos.gov.v1;

/** 10^18 as BigInt for fixed-point math */
const FIXED18_ONE = BigInt('1000000000000000000');

/**
 * Format a fixed-18 BigInt as a decimal string without precision loss.
 * E.g., 500000000000000000n -> "0.5", 1000000000000000000n -> "1.0"
 */
function formatFixed18(value: bigint): string {
  const isNegative = value < BigInt(0);
  const absValue = isNegative ? -value : value;
  const intPart = absValue / FIXED18_ONE;
  const fracPart = absValue % FIXED18_ONE;

  // Pad fraction to 18 digits, then trim trailing zeros
  const fracStr = fracPart.toString().padStart(18, '0').replace(/0+$/, '');

  const sign = isNegative ? '-' : '';
  if (fracStr === '') {
    return `${sign}${intPart}.0`;
  }
  return `${sign}${intPart}.${fracStr}`;
}

/**
 * Parse a decimal weight string to an 18-decimal fixed-point string.
 * Uses string manipulation to avoid floating-point precision loss.
 *
 * @param weightStr - Decimal string like "0.5", "0.333333333333333333", "1"
 * @returns String representation of weight * 10^18
 */
function parseWeightToFixed18(weightStr: string): string {
  // Validate format: must be a valid decimal number
  if (!/^\d+(\.\d+)?$/.test(weightStr)) {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid weight format: "${weightStr}". Expected decimal like "0.5" or "0.333333333333333333"`
    );
  }

  const [intPart, decPart = ''] = weightStr.split('.');

  // Pad or truncate decimal part to exactly 18 digits
  const paddedDecimal = decPart.padEnd(18, '0').slice(0, 18);

  // Combine integer and decimal parts
  const combined = intPart + paddedDecimal;

  // Remove leading zeros but keep at least one digit
  const result = combined.replace(/^0+/, '') || '0';

  return result;
}

/**
 * Route gov transaction to appropriate handler
 */
export async function routeGovTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean
): Promise<CosmosTxResult> {
  validateArgsLength(args, 'gov transaction');

  switch (subcommand) {
    case 'vote': {
      // Extract optional flags before positional args
      const metadataFlag = extractFlag(args, '--metadata', 'gov vote');
      const positionalArgs = filterConsumedArgs(args, metadataFlag.consumedIndices);

      requireArgs(positionalArgs, 2, ['proposal-id', 'option'], 'gov vote');
      const [proposalIdStr, optionStr] = positionalArgs;
      const proposalId = parseBigInt(proposalIdStr, 'proposal-id');
      const option = parseVoteOption(optionStr, VoteOption);
      const metadata = metadataFlag.value ?? '';

      const msg = {
        typeUrl: '/cosmos.gov.v1.MsgVote',
        value: MsgVote.fromPartial({
          proposalId,
          voter: senderAddress,
          option,
          metadata,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('gov', 'vote', result, waitForConfirmation);
    }

    case 'weighted-vote': {
      requireArgs(args, 2, ['proposal-id', 'options'], 'gov weighted-vote');
      const [proposalIdStr, optionsStr] = args;
      const proposalId = parseBigInt(proposalIdStr, 'proposal-id');

      // Parse weighted options (format: yes=0.5,no=0.3,abstain=0.2)
      const options = optionsStr.split(',').map((opt) => {
        const [optName, weightStr] = opt.split('=');
        if (!optName || !weightStr) {
          throw new ManifestMCPError(
            ManifestMCPErrorCode.TX_FAILED,
            `Invalid weighted vote format: ${opt}. Expected format: option=weight`
          );
        }
        const option = parseVoteOption(optName, VoteOption);
        // Weight is a decimal string (e.g., "0.5" -> "500000000000000000" for 18 decimals)
        // Use string-based conversion to avoid floating-point precision loss
        const weight = parseWeightToFixed18(weightStr);
        return { option, weight };
      });

      // Validate that weights sum to exactly 1.0 (10^18 in fixed-point)
      const totalWeight = options.reduce((sum, opt) => sum + BigInt(opt.weight), BigInt(0));
      if (totalWeight !== FIXED18_ONE) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          `Weighted vote options must sum to exactly 1.0. Got ${formatFixed18(totalWeight)} (${options.map(o => o.weight).join(' + ')} = ${totalWeight})`
        );
      }

      const msg = {
        typeUrl: '/cosmos.gov.v1.MsgVoteWeighted',
        value: MsgVoteWeighted.fromPartial({
          proposalId,
          voter: senderAddress,
          options,
          metadata: '',
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('gov', 'weighted-vote', result, waitForConfirmation);
    }

    case 'deposit': {
      requireArgs(args, 2, ['proposal-id', 'amount'], 'gov deposit');
      const [proposalIdStr, amountStr] = args;
      const proposalId = parseBigInt(proposalIdStr, 'proposal-id');
      const { amount, denom } = parseAmount(amountStr);

      const msg = {
        typeUrl: '/cosmos.gov.v1.MsgDeposit',
        value: MsgDeposit.fromPartial({
          proposalId,
          depositor: senderAddress,
          amount: [{ denom, amount }],
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('gov', 'deposit', result, waitForConfirmation);
    }

    default:
      throwUnsupportedSubcommand('tx', 'gov', subcommand);
  }
}
