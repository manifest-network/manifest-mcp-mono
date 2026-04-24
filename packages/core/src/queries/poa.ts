import type { ManifestQueryClient } from '../client.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import type {
  PoAAuthorityResult,
  PoAConsensusPowerResult,
  PoAPendingValidatorsResult,
} from '../types.js';
import { requireArgs } from './utils.js';

/** PoA query result union type */
type PoAQueryResult =
  | PoAAuthorityResult
  | PoAConsensusPowerResult
  | PoAPendingValidatorsResult;

/**
 * Route Proof-of-Authority (strangelove_ventures) query to manifestjs query client.
 */
export async function routePoAQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[],
): Promise<PoAQueryResult> {
  const poa = queryClient.strangelove_ventures.poa.v1;

  switch (subcommand) {
    case 'authority': {
      const result = await poa.poaAuthority({});
      return { authority: result.authority };
    }

    case 'consensus-power': {
      requireArgs(args, 1, ['validator-address'], 'poa consensus-power');
      const [validatorAddress] = args;
      const result = await poa.consensusPower({ validatorAddress });
      return { consensusPower: result.consensusPower };
    }

    case 'pending-validators': {
      const result = await poa.pendingValidators({});
      return { pending: result.pending };
    }

    default:
      throwUnsupportedSubcommand('query', 'poa', subcommand);
  }
}
