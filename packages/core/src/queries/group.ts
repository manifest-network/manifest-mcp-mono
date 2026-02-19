import { ManifestQueryClient } from '../client.js';
import {
  GroupInfoResult, GroupPolicyInfoResult, GroupMembersResult,
  GroupsResult, GroupPoliciesResult, GroupProposalResult,
  GroupProposalsResult, GroupVoteResult, GroupVotesResult,
  GroupTallyQueryResult
} from '../types.js';
import { parseBigInt, requireArgs, extractPaginationArgs, validateAddress } from './utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

/** Group query result union type */
type GroupQueryResultUnion =
  | GroupInfoResult
  | GroupPolicyInfoResult
  | GroupMembersResult
  | GroupsResult
  | GroupPoliciesResult
  | GroupProposalResult
  | GroupProposalsResult
  | GroupVoteResult
  | GroupVotesResult
  | GroupTallyQueryResult;

/**
 * Route group module query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeGroupQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[]
): Promise<GroupQueryResultUnion> {
  const group = queryClient.cosmos.group.v1;

  switch (subcommand) {
    case 'group-info': {
      requireArgs(args, 1, ['group-id'], 'group group-info');
      const groupId = parseBigInt(args[0], 'group-id');
      const result = await group.groupInfo({ groupId });
      return { info: result.info };
    }

    case 'group-policy-info': {
      requireArgs(args, 1, ['group-policy-address'], 'group group-policy-info');
      validateAddress(args[0], 'group policy address');
      const result = await group.groupPolicyInfo({ address: args[0] });
      return { info: result.info };
    }

    case 'group-members': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'group group-members');
      requireArgs(remainingArgs, 1, ['group-id'], 'group group-members');
      const groupId = parseBigInt(remainingArgs[0], 'group-id');
      const result = await group.groupMembers({ groupId, pagination });
      return { members: result.members, pagination: result.pagination };
    }

    case 'groups-by-admin': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'group groups-by-admin');
      requireArgs(remainingArgs, 1, ['admin-address'], 'group groups-by-admin');
      validateAddress(remainingArgs[0], 'admin address');
      const result = await group.groupsByAdmin({ admin: remainingArgs[0], pagination });
      return { groups: result.groups, pagination: result.pagination };
    }

    case 'group-policies-by-group': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'group group-policies-by-group');
      requireArgs(remainingArgs, 1, ['group-id'], 'group group-policies-by-group');
      const groupId = parseBigInt(remainingArgs[0], 'group-id');
      const result = await group.groupPoliciesByGroup({ groupId, pagination });
      return { groupPolicies: result.groupPolicies, pagination: result.pagination };
    }

    case 'group-policies-by-admin': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'group group-policies-by-admin');
      requireArgs(remainingArgs, 1, ['admin-address'], 'group group-policies-by-admin');
      validateAddress(remainingArgs[0], 'admin address');
      const result = await group.groupPoliciesByAdmin({ admin: remainingArgs[0], pagination });
      return { groupPolicies: result.groupPolicies, pagination: result.pagination };
    }

    case 'proposal': {
      requireArgs(args, 1, ['proposal-id'], 'group proposal');
      const proposalId = parseBigInt(args[0], 'proposal-id');
      const result = await group.proposal({ proposalId });
      return { proposal: result.proposal };
    }

    case 'proposals-by-group-policy': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'group proposals-by-group-policy');
      requireArgs(remainingArgs, 1, ['group-policy-address'], 'group proposals-by-group-policy');
      validateAddress(remainingArgs[0], 'group policy address');
      const result = await group.proposalsByGroupPolicy({ address: remainingArgs[0], pagination });
      return { proposals: result.proposals, pagination: result.pagination };
    }

    case 'vote': {
      requireArgs(args, 2, ['proposal-id', 'voter-address'], 'group vote');
      const proposalId = parseBigInt(args[0], 'proposal-id');
      validateAddress(args[1], 'voter address');
      const result = await group.voteByProposalVoter({ proposalId, voter: args[1] });
      return { vote: result.vote };
    }

    case 'votes-by-proposal': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'group votes-by-proposal');
      requireArgs(remainingArgs, 1, ['proposal-id'], 'group votes-by-proposal');
      const proposalId = parseBigInt(remainingArgs[0], 'proposal-id');
      const result = await group.votesByProposal({ proposalId, pagination });
      return { votes: result.votes, pagination: result.pagination };
    }

    case 'votes-by-voter': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'group votes-by-voter');
      requireArgs(remainingArgs, 1, ['voter-address'], 'group votes-by-voter');
      validateAddress(remainingArgs[0], 'voter address');
      const result = await group.votesByVoter({ voter: remainingArgs[0], pagination });
      return { votes: result.votes, pagination: result.pagination };
    }

    case 'groups-by-member': {
      const { pagination, remainingArgs } = extractPaginationArgs(args, 'group groups-by-member');
      requireArgs(remainingArgs, 1, ['member-address'], 'group groups-by-member');
      validateAddress(remainingArgs[0], 'member address');
      const result = await group.groupsByMember({ address: remainingArgs[0], pagination });
      return { groups: result.groups, pagination: result.pagination };
    }

    case 'tally': {
      requireArgs(args, 1, ['proposal-id'], 'group tally');
      const proposalId = parseBigInt(args[0], 'proposal-id');
      const result = await group.tallyResult({ proposalId });
      return { tally: result.tally };
    }

    case 'groups': {
      const { pagination } = extractPaginationArgs(args, 'group groups');
      const result = await group.groups({ pagination });
      return { groups: result.groups, pagination: result.pagination };
    }

    default:
      throwUnsupportedSubcommand('query', 'group', subcommand);
  }
}
