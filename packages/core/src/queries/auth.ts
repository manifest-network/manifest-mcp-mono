import { ManifestQueryClient } from '../client.js';
import {
  ManifestMCPErrorCode,
  AuthAccountResult, AuthAccountsResult, AuthParamsResult, ModuleAccountsResult,
  AddressBytesToStringResult, AddressStringToBytesResult, Bech32PrefixResult, AccountInfoResult
} from '../types.js';
import { requireArgs, extractPaginationArgs } from './utils.js';
import { parseHexBytes, bytesToHex } from '../transactions/utils.js';
import { throwUnsupportedSubcommand } from '../modules.js';

/** Maximum address bytes length (256 bytes, more than enough for any address) */
const MAX_ADDRESS_BYTES = 256;

/** Auth query result union type */
type AuthQueryResult =
  | AuthAccountResult
  | AuthAccountsResult
  | AuthParamsResult
  | ModuleAccountsResult
  | AddressBytesToStringResult
  | AddressStringToBytesResult
  | Bech32PrefixResult
  | AccountInfoResult;

/**
 * Route auth query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeAuthQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[]
): Promise<AuthQueryResult> {
  const auth = queryClient.cosmos.auth.v1beta1;

  switch (subcommand) {
    case 'account': {
      requireArgs(args, 1, ['address'], 'auth account');
      const [address] = args;
      const result = await auth.account({ address });
      return { account: result.account };
    }

    case 'accounts': {
      const { pagination } = extractPaginationArgs(args, 'auth accounts');
      const result = await auth.accounts({ pagination });
      return { accounts: result.accounts, pagination: result.pagination };
    }

    case 'params': {
      const result = await auth.params({});
      return { params: result.params };
    }

    case 'module-accounts': {
      const result = await auth.moduleAccounts({});
      return { accounts: result.accounts };
    }

    case 'module-account-by-name': {
      requireArgs(args, 1, ['name'], 'auth module-account-by-name');
      const [name] = args;
      const result = await auth.moduleAccountByName({ name });
      return { account: result.account };
    }

    case 'address-bytes-to-string': {
      requireArgs(args, 1, ['address-bytes'], 'auth address-bytes-to-string');
      const addressBytes = parseHexBytes(args[0], 'address-bytes', MAX_ADDRESS_BYTES, ManifestMCPErrorCode.QUERY_FAILED);
      const result = await auth.addressBytesToString({ addressBytes });
      return { addressString: result.addressString };
    }

    case 'address-string-to-bytes': {
      requireArgs(args, 1, ['address-string'], 'auth address-string-to-bytes');
      const [addressString] = args;
      const result = await auth.addressStringToBytes({ addressString });
      return { addressBytes: bytesToHex(result.addressBytes) };
    }

    case 'bech32-prefix': {
      const result = await auth.bech32Prefix({});
      return { bech32Prefix: result.bech32Prefix };
    }

    case 'account-info': {
      requireArgs(args, 1, ['address'], 'auth account-info');
      const [address] = args;
      const result = await auth.accountInfo({ address });
      return { info: result.info };
    }

    default:
      throwUnsupportedSubcommand('query', 'auth', subcommand);
  }
}
