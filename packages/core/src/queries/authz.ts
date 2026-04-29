import type { ManifestQueryClient } from '../client.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import { extractFlag, filterConsumedArgs } from '../transactions/utils.js';
import type {
  AuthzGranteeGrantsResult,
  AuthzGranterGrantsResult,
  AuthzGrantsResult,
} from '../types.js';
import { ManifestMCPErrorCode } from '../types.js';
import { extractPaginationArgs, requireArgs } from './utils.js';

/** Authz query result union type */
type AuthzQueryResult =
  | AuthzGrantsResult
  | AuthzGranterGrantsResult
  | AuthzGranteeGrantsResult;

/**
 * Route authz query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeAuthzQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[],
): Promise<AuthzQueryResult> {
  const authz = queryClient.cosmos.authz.v1beta1;

  switch (subcommand) {
    case 'grants': {
      const { value: msgTypeUrl, consumedIndices } = extractFlag(
        args,
        '--msg-type-url',
        'authz grants',
        ManifestMCPErrorCode.QUERY_FAILED,
      );
      const positional = filterConsumedArgs(args, consumedIndices);
      const { pagination, remainingArgs } = extractPaginationArgs(
        positional,
        'authz grants',
      );
      requireArgs(
        remainingArgs,
        2,
        ['granter-address', 'grantee-address'],
        'authz grants',
      );
      const [granter, grantee] = remainingArgs;
      const result = await authz.grants({
        granter,
        grantee,
        msgTypeUrl: msgTypeUrl ?? '',
        pagination,
      });
      return { grants: result.grants, pagination: result.pagination };
    }

    case 'granter-grants': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'authz granter-grants',
      );
      requireArgs(
        remainingArgs,
        1,
        ['granter-address'],
        'authz granter-grants',
      );
      const [granter] = remainingArgs;
      const result = await authz.granterGrants({ granter, pagination });
      return { grants: result.grants, pagination: result.pagination };
    }

    case 'grantee-grants': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'authz grantee-grants',
      );
      requireArgs(
        remainingArgs,
        1,
        ['grantee-address'],
        'authz grantee-grants',
      );
      const [grantee] = remainingArgs;
      const result = await authz.granteeGrants({ grantee, pagination });
      return { grants: result.grants, pagination: result.pagination };
    }

    default:
      throwUnsupportedSubcommand('query', 'authz', subcommand);
  }
}
