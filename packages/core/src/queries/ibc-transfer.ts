import type { ManifestQueryClient } from '../client.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import type {
  IbcDenomTraceResult,
  IbcDenomTracesResult,
  IbcTransferParamsResult,
} from '../types.js';
import { extractPaginationArgs, requireArgs } from './utils.js';

/** IBC transfer query result union type */
type IbcTransferQueryResult =
  | IbcDenomTraceResult
  | IbcDenomTracesResult
  | IbcTransferParamsResult;

/**
 * Route IBC transfer query to manifestjs query client.
 */
export async function routeIbcTransferQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[],
): Promise<IbcTransferQueryResult> {
  const transfer = queryClient.ibc.applications.transfer.v1;

  switch (subcommand) {
    case 'params': {
      const result = await transfer.params({});
      return { params: result.params };
    }

    case 'denom-trace': {
      requireArgs(args, 1, ['hash'], 'ibc-transfer denom-trace');
      const [hash] = args;
      const result = await transfer.denomTrace({ hash });
      return { denomTrace: result.denomTrace };
    }

    case 'denom-traces': {
      const { pagination } = extractPaginationArgs(
        args,
        'ibc-transfer denom-traces',
      );
      const result = await transfer.denomTraces({ pagination });
      return {
        denomTraces: result.denomTraces,
        pagination: result.pagination,
      };
    }

    default:
      throwUnsupportedSubcommand('query', 'ibc-transfer', subcommand);
  }
}
