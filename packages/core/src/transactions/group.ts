import { SigningStargateClient } from '@cosmjs/stargate';
import { fromBase64 } from '@cosmjs/encoding';
import { cosmos } from '@manifest-network/manifestjs';
import { CosmosTxResult, ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import {
  buildTxResult, validateAddress, validateArgsLength,
  extractFlag, filterConsumedArgs, requireArgs, parseColonPair,
  parseBigInt, parseVoteOption, extractBooleanFlag,
} from './utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

const {
  MsgCreateGroup, MsgUpdateGroupMembers, MsgUpdateGroupAdmin,
  MsgUpdateGroupMetadata, MsgCreateGroupPolicy, MsgUpdateGroupPolicyAdmin,
  MsgCreateGroupWithPolicy, MsgUpdateGroupPolicyDecisionPolicy,
  MsgUpdateGroupPolicyMetadata, MsgSubmitProposal, MsgWithdrawProposal,
  MsgVote, MsgExec, MsgLeaveGroup,
  VoteOption, Exec,
} = cosmos.group.v1;

/**
 * Parse an exec mode string. Accepts 'try' or '1' for EXEC_TRY.
 * Returns EXEC_UNSPECIFIED by default.
 */
function parseExec(value: string | undefined): number {
  if (!value) return Exec.EXEC_UNSPECIFIED;
  const lower = value.toLowerCase();
  if (lower === 'try' || lower === '1') return Exec.EXEC_TRY;
  throw new ManifestMCPError(
    ManifestMCPErrorCode.TX_FAILED,
    `Invalid exec mode: "${value}". Expected: "try" for immediate execution.`
  );
}

interface DecisionPolicyWindows {
  votingPeriod: { seconds: bigint; nanos: number };
  minExecutionPeriod: { seconds: bigint; nanos: number };
}

interface ThresholdPolicy {
  $typeUrl: '/cosmos.group.v1.ThresholdDecisionPolicy';
  threshold: string;
  windows: DecisionPolicyWindows;
}

interface PercentagePolicy {
  $typeUrl: '/cosmos.group.v1.PercentageDecisionPolicy';
  percentage: string;
  windows: DecisionPolicyWindows;
}

/**
 * Build a decision policy (ThresholdDecisionPolicy or PercentageDecisionPolicy)
 * wrapped for use with fromPartial().
 */
function buildDecisionPolicy(
  policyType: string,
  value: string,
  votingPeriodSecs: string,
  minExecPeriodSecs: string
): ThresholdPolicy | PercentagePolicy {
  const votingSecs = parseBigInt(votingPeriodSecs, 'voting-period-secs');
  const minExecSecs = parseBigInt(minExecPeriodSecs, 'min-execution-period-secs');

  const windows: DecisionPolicyWindows = {
    votingPeriod: { seconds: votingSecs, nanos: 0 },
    minExecutionPeriod: { seconds: minExecSecs, nanos: 0 },
  };

  switch (policyType.toLowerCase()) {
    case 'threshold':
      return {
        $typeUrl: '/cosmos.group.v1.ThresholdDecisionPolicy' as const,
        threshold: value,
        windows,
      };
    case 'percentage':
      return {
        $typeUrl: '/cosmos.group.v1.PercentageDecisionPolicy' as const,
        percentage: value,
        windows,
      };
    default:
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Invalid policy type: "${policyType}". Expected "threshold" or "percentage".`
      );
  }
}

/**
 * Parse address:weight pairs into MemberRequest array.
 * Each pair is validated for proper address format and non-negative weight.
 */
function parseMemberRequests(
  pairs: string[]
): { address: string; weight: string; metadata: string }[] {
  return pairs.map(pair => {
    const [address, weight] = parseColonPair(pair, 'address', 'weight', 'member');
    validateAddress(address, 'member address');
    if (!/^\d+(\.\d+)?$/.test(weight)) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Invalid member weight: "${weight}" for address "${address}". Expected a non-negative decimal string (e.g., "1", "0.5").`
      );
    }
    return { address, weight, metadata: '' };
  });
}

/**
 * Parse JSON message strings into Any[] for MsgSubmitProposal.
 * Each JSON object must have a typeUrl and a base64-encoded value field.
 * The value must contain protobuf-encoded bytes (not JSON).
 */
function parseProposalMessages(
  jsonArgs: string[]
): { typeUrl: string; value: Uint8Array }[] {
  return jsonArgs.map((jsonStr, index) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Invalid JSON in message at index ${index}: ${jsonStr}`
      );
    }

    const { typeUrl, value } = parsed;
    if (typeof typeUrl !== 'string' || !typeUrl) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Message at index ${index} missing required "typeUrl" field.`
      );
    }

    if (typeof value !== 'string' || !value) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Message at index ${index} missing required "value" field. Provide protobuf-encoded bytes as a base64 string.`
      );
    }

    try {
      const bytes = fromBase64(value);
      return { typeUrl, value: bytes };
    } catch {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Message at index ${index}: invalid base64 value.`
      );
    }
  });
}

/**
 * Route group transaction to appropriate handler
 */
export async function routeGroupTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean
): Promise<CosmosTxResult> {
  validateArgsLength(args, 'group transaction');

  switch (subcommand) {
    case 'create-group': {
      requireArgs(args, 2, ['metadata', 'address:weight'], 'group create-group');
      const [metadata, ...memberPairs] = args;
      const members = parseMemberRequests(memberPairs);

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgCreateGroup',
        value: MsgCreateGroup.fromPartial({
          admin: senderAddress,
          members,
          metadata,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'create-group', result, waitForConfirmation);
    }

    case 'update-group-members': {
      requireArgs(args, 2, ['group-id', 'address:weight'], 'group update-group-members');
      const [groupIdStr, ...memberPairs] = args;
      const groupId = parseBigInt(groupIdStr, 'group-id');
      const memberUpdates = parseMemberRequests(memberPairs);

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgUpdateGroupMembers',
        value: MsgUpdateGroupMembers.fromPartial({
          admin: senderAddress,
          groupId,
          memberUpdates,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'update-group-members', result, waitForConfirmation);
    }

    case 'update-group-admin': {
      requireArgs(args, 2, ['group-id', 'new-admin-address'], 'group update-group-admin');
      const [groupIdStr, newAdmin] = args;
      const groupId = parseBigInt(groupIdStr, 'group-id');
      validateAddress(newAdmin, 'new admin address');

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgUpdateGroupAdmin',
        value: MsgUpdateGroupAdmin.fromPartial({
          admin: senderAddress,
          groupId,
          newAdmin,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'update-group-admin', result, waitForConfirmation);
    }

    case 'update-group-metadata': {
      requireArgs(args, 2, ['group-id', 'metadata'], 'group update-group-metadata');
      const [groupIdStr, metadata] = args;
      const groupId = parseBigInt(groupIdStr, 'group-id');

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgUpdateGroupMetadata',
        value: MsgUpdateGroupMetadata.fromPartial({
          admin: senderAddress,
          groupId,
          metadata,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'update-group-metadata', result, waitForConfirmation);
    }

    case 'create-group-policy': {
      requireArgs(args, 6, ['group-id', 'metadata', 'policy-type', 'threshold-or-pct', 'voting-period-secs', 'min-execution-period-secs'], 'group create-group-policy');
      const [groupIdStr, metadata, policyType, value, votingPeriodSecs, minExecPeriodSecs] = args;
      const groupId = parseBigInt(groupIdStr, 'group-id');
      const decisionPolicy = buildDecisionPolicy(policyType, value, votingPeriodSecs, minExecPeriodSecs);

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgCreateGroupPolicy',
        value: MsgCreateGroupPolicy.fromPartial({
          admin: senderAddress,
          groupId,
          metadata,
          decisionPolicy,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'create-group-policy', result, waitForConfirmation);
    }

    case 'update-group-policy-admin': {
      requireArgs(args, 2, ['group-policy-address', 'new-admin-address'], 'group update-group-policy-admin');
      const [groupPolicyAddress, newAdmin] = args;
      validateAddress(groupPolicyAddress, 'group policy address');
      validateAddress(newAdmin, 'new admin address');

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgUpdateGroupPolicyAdmin',
        value: MsgUpdateGroupPolicyAdmin.fromPartial({
          admin: senderAddress,
          groupPolicyAddress,
          newAdmin,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'update-group-policy-admin', result, waitForConfirmation);
    }

    case 'create-group-with-policy': {
      // Extract optional --group-policy-as-admin flag
      const { value: groupPolicyAsAdmin, remainingArgs: afterBool } = extractBooleanFlag(args, '--group-policy-as-admin');

      requireArgs(afterBool, 7, ['group-metadata', 'group-policy-metadata', 'policy-type', 'threshold-or-pct', 'voting-period-secs', 'min-execution-period-secs', 'address:weight'], 'group create-group-with-policy');
      const [groupMetadata, groupPolicyMetadata, policyType, value, votingPeriodSecs, minExecPeriodSecs, ...memberPairs] = afterBool;

      const members = parseMemberRequests(memberPairs);
      const decisionPolicy = buildDecisionPolicy(policyType, value, votingPeriodSecs, minExecPeriodSecs);

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgCreateGroupWithPolicy',
        value: MsgCreateGroupWithPolicy.fromPartial({
          admin: senderAddress,
          members,
          groupMetadata,
          groupPolicyMetadata,
          groupPolicyAsAdmin,
          decisionPolicy,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'create-group-with-policy', result, waitForConfirmation);
    }

    case 'update-group-policy-decision-policy': {
      requireArgs(args, 5, ['group-policy-address', 'policy-type', 'threshold-or-pct', 'voting-period-secs', 'min-execution-period-secs'], 'group update-group-policy-decision-policy');
      const [groupPolicyAddress, policyType, value, votingPeriodSecs, minExecPeriodSecs] = args;
      validateAddress(groupPolicyAddress, 'group policy address');
      const decisionPolicy = buildDecisionPolicy(policyType, value, votingPeriodSecs, minExecPeriodSecs);

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgUpdateGroupPolicyDecisionPolicy',
        value: MsgUpdateGroupPolicyDecisionPolicy.fromPartial({
          admin: senderAddress,
          groupPolicyAddress,
          decisionPolicy,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'update-group-policy-decision-policy', result, waitForConfirmation);
    }

    case 'update-group-policy-metadata': {
      requireArgs(args, 2, ['group-policy-address', 'metadata'], 'group update-group-policy-metadata');
      const [groupPolicyAddress, metadata] = args;
      validateAddress(groupPolicyAddress, 'group policy address');

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgUpdateGroupPolicyMetadata',
        value: MsgUpdateGroupPolicyMetadata.fromPartial({
          admin: senderAddress,
          groupPolicyAddress,
          metadata,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'update-group-policy-metadata', result, waitForConfirmation);
    }

    case 'submit-proposal': {
      // Extract optional flags
      const execFlag = extractFlag(args, '--exec', 'group submit-proposal');
      const metadataFlag = extractFlag(args, '--metadata', 'group submit-proposal');
      const allConsumed = [...execFlag.consumedIndices, ...metadataFlag.consumedIndices];
      const positionalArgs = filterConsumedArgs(args, allConsumed);

      requireArgs(positionalArgs, 3, ['group-policy-address', 'title', 'summary'], 'group submit-proposal');
      const [groupPolicyAddress, title, summary, ...messageJsonArgs] = positionalArgs;
      validateAddress(groupPolicyAddress, 'group policy address');

      const exec = parseExec(execFlag.value);
      const metadata = metadataFlag.value ?? '';
      const messages = messageJsonArgs.length > 0 ? parseProposalMessages(messageJsonArgs) : [];

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgSubmitProposal',
        value: MsgSubmitProposal.fromPartial({
          groupPolicyAddress,
          proposers: [senderAddress],
          metadata,
          messages,
          exec,
          title,
          summary,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'submit-proposal', result, waitForConfirmation);
    }

    case 'withdraw-proposal': {
      requireArgs(args, 1, ['proposal-id'], 'group withdraw-proposal');
      const proposalId = parseBigInt(args[0], 'proposal-id');

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgWithdrawProposal',
        value: MsgWithdrawProposal.fromPartial({
          proposalId,
          address: senderAddress,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'withdraw-proposal', result, waitForConfirmation);
    }

    case 'vote': {
      // Extract optional flags
      const execFlag = extractFlag(args, '--exec', 'group vote');
      const metadataFlag = extractFlag(args, '--metadata', 'group vote');
      const allConsumed = [...execFlag.consumedIndices, ...metadataFlag.consumedIndices];
      const positionalArgs = filterConsumedArgs(args, allConsumed);

      requireArgs(positionalArgs, 2, ['proposal-id', 'option'], 'group vote');
      const [proposalIdStr, optionStr] = positionalArgs;
      const proposalId = parseBigInt(proposalIdStr, 'proposal-id');
      const option = parseVoteOption(optionStr, VoteOption);
      const exec = parseExec(execFlag.value);
      const metadata = metadataFlag.value ?? '';

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgVote',
        value: MsgVote.fromPartial({
          proposalId,
          voter: senderAddress,
          option,
          metadata,
          exec,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'vote', result, waitForConfirmation);
    }

    case 'exec': {
      requireArgs(args, 1, ['proposal-id'], 'group exec');
      const proposalId = parseBigInt(args[0], 'proposal-id');

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgExec',
        value: MsgExec.fromPartial({
          proposalId,
          executor: senderAddress,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'exec', result, waitForConfirmation);
    }

    case 'leave-group': {
      requireArgs(args, 1, ['group-id'], 'group leave-group');
      const groupId = parseBigInt(args[0], 'group-id');

      const msg = {
        typeUrl: '/cosmos.group.v1.MsgLeaveGroup',
        value: MsgLeaveGroup.fromPartial({
          address: senderAddress,
          groupId,
        }),
      };

      const result = await client.signAndBroadcast(senderAddress, [msg], 'auto');
      return buildTxResult('group', 'leave-group', result, waitForConfirmation);
    }

    default:
      throwUnsupportedSubcommand('tx', 'group', subcommand);
  }
}
