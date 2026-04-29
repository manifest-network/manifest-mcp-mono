import type { ManifestQueryClient } from '../client.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import type {
  MintAnnualProvisionsResult,
  MintInflationResult,
  MintParamsResult,
} from '../types.js';

/** Mint query result union type */
type MintQueryResult =
  | MintParamsResult
  | MintInflationResult
  | MintAnnualProvisionsResult;

/**
 * Decode an x/mint Dec value. The RPC returns the textual decimal encoded as
 * UTF-8 bytes; the LCD adapter routes through `fromJSON` which yields a
 * string. Accept either shape and normalize to string.
 */
function decodeDec(value: Uint8Array | string | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return new TextDecoder().decode(value);
}

/**
 * Route mint query to manifestjs query client
 */
export async function routeMintQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  _args: string[],
): Promise<MintQueryResult> {
  const mint = queryClient.cosmos.mint.v1beta1;

  switch (subcommand) {
    case 'params': {
      const result = await mint.params({});
      return { params: result.params };
    }

    case 'inflation': {
      const result = await mint.inflation({});
      return { inflation: decodeDec(result.inflation) };
    }

    case 'annual-provisions': {
      const result = await mint.annualProvisions({});
      return { annualProvisions: decodeDec(result.annualProvisions) };
    }

    default:
      throwUnsupportedSubcommand('query', 'mint', subcommand);
  }
}
