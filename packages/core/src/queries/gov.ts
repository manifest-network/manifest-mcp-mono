import type { ManifestQueryClient } from '../client.js';
import { throwUnsupportedSubcommand } from '../module-metadata.js';
import type {
  DepositResult,
  DepositsResult,
  GovParamsResult,
  ProposalResult,
  ProposalsResult,
  TallyResult,
  VoteResult,
  VotesResult,
} from '../types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import {
  extractPaginationArgs,
  parseInteger,
  parseUint64,
  requireArgs,
} from './utils.js';

/** Gov query result union type */
type GovQueryResult =
  | ProposalResult
  | ProposalsResult
  | VoteResult
  | VotesResult
  | DepositResult
  | DepositsResult
  | TallyResult
  | GovParamsResult;

/**
 * Route gov query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeGovQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[],
): Promise<GovQueryResult> {
  const gov = queryClient.cosmos.gov.v1;

  switch (subcommand) {
    case 'proposal': {
      requireArgs(args, 1, ['proposal-id'], 'gov proposal');
      const proposalId = parseUint64(args[0], 'proposal-id');
      const result = await gov.proposal({ proposalId });
      return { proposal: result.proposal };
    }

    case 'proposals': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'gov proposals',
      );
      // All optional: status filter, voter, depositor
      const proposalStatus = remainingArgs[0]
        ? parseInteger(remainingArgs[0], 'status')
        : 0;
      // Cosmos ProposalStatus is 0 (no filter) through 5 (failed). The
      // protobuf int32 encoder would otherwise wrap larger safe JS integers.
      if (proposalStatus < 0 || proposalStatus > 5) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          'Invalid status: expected a ProposalStatus integer from 0 through 5.',
        );
      }
      const voter = remainingArgs[1] || '';
      const depositor = remainingArgs[2] || '';
      const result = await gov.proposals({
        proposalStatus,
        voter,
        depositor,
        pagination,
      });
      return { proposals: result.proposals, pagination: result.pagination };
    }

    case 'vote': {
      requireArgs(args, 2, ['proposal-id', 'voter-address'], 'gov vote');
      const proposalId = parseUint64(args[0], 'proposal-id');
      const voter = args[1];
      const result = await gov.vote({ proposalId, voter });
      return { vote: result.vote };
    }

    case 'votes': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'gov votes',
      );
      requireArgs(remainingArgs, 1, ['proposal-id'], 'gov votes');
      const proposalId = parseUint64(remainingArgs[0], 'proposal-id');
      const result = await gov.votes({ proposalId, pagination });
      return { votes: result.votes, pagination: result.pagination };
    }

    case 'deposit': {
      requireArgs(args, 2, ['proposal-id', 'depositor-address'], 'gov deposit');
      const proposalId = parseUint64(args[0], 'proposal-id');
      const depositor = args[1];
      const result = await gov.deposit({ proposalId, depositor });
      return { deposit: result.deposit };
    }

    case 'deposits': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'gov deposits',
      );
      requireArgs(remainingArgs, 1, ['proposal-id'], 'gov deposits');
      const proposalId = parseUint64(remainingArgs[0], 'proposal-id');
      const result = await gov.deposits({ proposalId, pagination });
      return { deposits: result.deposits, pagination: result.pagination };
    }

    case 'tally': {
      requireArgs(args, 1, ['proposal-id'], 'gov tally');
      const proposalId = parseUint64(args[0], 'proposal-id');
      const result = await gov.tallyResult({ proposalId });
      return { tally: result.tally };
    }

    case 'params': {
      // Optional: params type (defaults to 'tallying')
      const paramsType = args[0] || 'tallying';
      const result = await gov.params({ paramsType });
      return {
        votingParams: result.votingParams,
        depositParams: result.depositParams,
        tallyParams: result.tallyParams,
        params: result.params,
      };
    }

    default:
      throwUnsupportedSubcommand('query', 'gov', subcommand);
  }
}
