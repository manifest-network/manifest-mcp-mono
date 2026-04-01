import { fromHex, fromUtf8, toBase64, toUtf8 } from '@cosmjs/encoding';
import type { ManifestQueryClient } from '../client.js';
import { throwUnsupportedSubcommand } from '../modules.js';
import type {
  WasmAllContractStateResult,
  WasmBuildAddressResult,
  WasmCodeInfoResult,
  WasmCodeResult,
  WasmCodesResult,
  WasmContractHistoryResult,
  WasmContractInfoResult,
  WasmContractsByCodeResult,
  WasmContractsByCreatorResult,
  WasmLimitsConfigResult,
  WasmParamsResult,
  WasmPinnedCodesResult,
  WasmRawContractStateResult,
  WasmSmartContractStateResult,
} from '../types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import { extractPaginationArgs, parseBigInt, requireArgs } from './utils.js';

/** Wasm query result union type */
type WasmQueryResult =
  | WasmContractInfoResult
  | WasmContractHistoryResult
  | WasmContractsByCodeResult
  | WasmAllContractStateResult
  | WasmRawContractStateResult
  | WasmSmartContractStateResult
  | WasmCodeResult
  | WasmCodesResult
  | WasmCodeInfoResult
  | WasmPinnedCodesResult
  | WasmParamsResult
  | WasmContractsByCreatorResult
  | WasmLimitsConfigResult
  | WasmBuildAddressResult;

/**
 * Route wasm query to manifestjs query client
 *
 * Paginated queries support --limit flag (default: 100, max: 1000)
 */
export async function routeWasmQuery(
  queryClient: ManifestQueryClient,
  subcommand: string,
  args: string[],
): Promise<WasmQueryResult> {
  const wasm = queryClient.cosmwasm.wasm.v1;

  switch (subcommand) {
    case 'contract-info': {
      requireArgs(args, 1, ['address'], 'wasm contract-info');
      const [address] = args;
      const result = await wasm.contractInfo({ address });
      return { contractInfo: result.contractInfo };
    }

    case 'contract-history': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'wasm contract-history',
      );
      requireArgs(remainingArgs, 1, ['address'], 'wasm contract-history');
      const [address] = remainingArgs;
      const result = await wasm.contractHistory({ address, pagination });
      return { entries: result.entries, pagination: result.pagination };
    }

    case 'contracts-by-code': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'wasm contracts-by-code',
      );
      requireArgs(remainingArgs, 1, ['code_id'], 'wasm contracts-by-code');
      const [codeIdStr] = remainingArgs;
      const codeId = parseBigInt(codeIdStr, 'code_id');
      const result = await wasm.contractsByCode({ codeId, pagination });
      return { contracts: result.contracts, pagination: result.pagination };
    }

    case 'all-contract-state': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'wasm all-contract-state',
      );
      requireArgs(remainingArgs, 1, ['address'], 'wasm all-contract-state');
      const [address] = remainingArgs;
      const result = await wasm.allContractState({ address, pagination });
      return { models: result.models, pagination: result.pagination };
    }

    case 'raw-contract-state': {
      requireArgs(
        args,
        2,
        ['address', 'query_data_hex'],
        'wasm raw-contract-state',
      );
      const [address, queryDataHex] = args;
      let queryData: Uint8Array;
      try {
        queryData = fromHex(queryDataHex);
      } catch (error) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Invalid hex string for query_data: "${queryDataHex}". ${error instanceof Error ? error.message : 'Must contain only hexadecimal characters.'}`,
        );
      }
      const result = await wasm.rawContractState({ address, queryData });
      return { data: toBase64(result.data) };
    }

    case 'smart-contract-state': {
      requireArgs(
        args,
        2,
        ['address', 'query_json'],
        'wasm smart-contract-state',
      );
      const [address, queryJson] = args;
      try {
        JSON.parse(queryJson);
      } catch {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Invalid JSON for query_json: "${queryJson}". Must be valid JSON.`,
        );
      }
      const result = await wasm.smartContractState({
        address,
        queryData: toUtf8(queryJson),
      });
      let decoded: unknown;
      try {
        decoded = JSON.parse(fromUtf8(result.data));
      } catch (error) {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.QUERY_FAILED,
          `Failed to decode smart contract response from "${address}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { data: decoded };
    }

    case 'code': {
      requireArgs(args, 1, ['code_id'], 'wasm code');
      const [codeIdStr] = args;
      const codeId = parseBigInt(codeIdStr, 'code_id');
      const result = await wasm.code({ codeId });
      return { codeInfo: result.codeInfo, data: toBase64(result.data) };
    }

    case 'codes': {
      const { pagination } = extractPaginationArgs(args, 'wasm codes');
      const result = await wasm.codes({ pagination });
      return { codeInfos: result.codeInfos, pagination: result.pagination };
    }

    case 'code-info': {
      requireArgs(args, 1, ['code_id'], 'wasm code-info');
      const [codeIdStr] = args;
      const codeId = parseBigInt(codeIdStr, 'code_id');
      const result = await wasm.codeInfo({ codeId });
      return {
        codeInfo: {
          codeId: result.codeId,
          creator: result.creator,
          dataHash: result.checksum,
          instantiatePermission: result.instantiatePermission,
        },
      };
    }

    case 'pinned-codes': {
      const { pagination } = extractPaginationArgs(args, 'wasm pinned-codes');
      const result = await wasm.pinnedCodes({ pagination });
      return { codeIds: result.codeIds, pagination: result.pagination };
    }

    case 'params': {
      const result = await wasm.params({});
      return { params: result.params };
    }

    case 'contracts-by-creator': {
      const { pagination, remainingArgs } = extractPaginationArgs(
        args,
        'wasm contracts-by-creator',
      );
      requireArgs(
        remainingArgs,
        1,
        ['creator_address'],
        'wasm contracts-by-creator',
      );
      const [creatorAddress] = remainingArgs;
      const result = await wasm.contractsByCreator({
        creatorAddress,
        pagination,
      });
      return {
        contractAddresses: result.contractAddresses,
        pagination: result.pagination,
      };
    }

    case 'wasm-limits-config': {
      const result = await wasm.wasmLimitsConfig({});
      return { config: result.config };
    }

    case 'build-address': {
      requireArgs(
        args,
        3,
        ['code_hash', 'creator_address', 'salt'],
        'wasm build-address',
      );
      const [codeHash, creatorAddress, salt] = args;
      const result = await wasm.buildAddress({
        codeHash,
        creatorAddress,
        salt,
        initArgs: new Uint8Array(),
      });
      return { address: result.address };
    }

    default:
      throwUnsupportedSubcommand('query', 'wasm', subcommand);
  }
}
