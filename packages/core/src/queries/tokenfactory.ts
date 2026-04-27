import type { ManifestQueryClient } from '../client.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import type {
  DenomAuthorityMetadataResult,
  DenomsFromAdminResult,
  DenomsFromCreatorResult,
  TokenfactoryParamsResult,
} from '../types.js';
import { requireArgs } from './utils.js';

/** Tokenfactory query result union type */
type TokenfactoryQueryResult =
  | TokenfactoryParamsResult
  | DenomAuthorityMetadataResult
  | DenomsFromCreatorResult
  | DenomsFromAdminResult;

/**
 * Route tokenfactory (osmosis) query to manifestjs query client.
 */
export async function routeTokenfactoryQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[],
): Promise<TokenfactoryQueryResult> {
  const tf = queryClient.osmosis.tokenfactory.v1beta1;

  switch (subcommand) {
    case 'params': {
      const result = await tf.params({});
      return { params: result.params };
    }

    case 'denom-authority-metadata': {
      requireArgs(args, 1, ['denom'], 'tokenfactory denom-authority-metadata');
      const [denom] = args;
      const result = await tf.denomAuthorityMetadata({ denom });
      return { authorityMetadata: result.authorityMetadata };
    }

    case 'denoms-from-creator': {
      requireArgs(args, 1, ['creator'], 'tokenfactory denoms-from-creator');
      const [creator] = args;
      const result = await tf.denomsFromCreator({ creator });
      return { denoms: result.denoms };
    }

    case 'denoms-from-admin': {
      requireArgs(args, 1, ['admin'], 'tokenfactory denoms-from-admin');
      const [admin] = args;
      const result = await tf.denomsFromAdmin({ admin });
      return { denoms: result.denoms };
    }

    default:
      throwUnsupportedSubcommand('query', 'tokenfactory', subcommand);
  }
}
