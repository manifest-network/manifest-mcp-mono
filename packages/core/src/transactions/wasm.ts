import { fromBase64, toUtf8 } from '@cosmjs/encoding';
import type { SigningStargateClient } from '@cosmjs/stargate';
import { cosmwasm } from '@manifest-network/manifestjs';
import { throwUnsupportedSubcommand } from '../modules.js';
import type { BuiltMessages, CosmosTxResult, TxOptions } from '../types.js';
import { ManifestMCPError, ManifestMCPErrorCode } from '../types.js';
import {
  buildGasFee,
  buildTxResult,
  extractFlag,
  filterConsumedArgs,
  parseAmount,
  parseBigInt,
  requireArgs,
  validateAddress,
  validateArgsLength,
  validateMemo,
} from './utils.js';

const {
  MsgStoreCode,
  MsgInstantiateContract,
  MsgInstantiateContract2,
  MsgExecuteContract,
  MsgMigrateContract,
  MsgUpdateAdmin,
  MsgClearAdmin,
} = cosmwasm.wasm.v1;

/**
 * Parse a comma-separated funds string into a Coin array.
 * e.g., "100umfx,50upwr" -> [{ denom: "umfx", amount: "100" }, { denom: "upwr", amount: "50" }]
 */
function parseFunds(fundsStr: string): { denom: string; amount: string }[] {
  return fundsStr.split(',').map((part) => {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new ManifestMCPError(
        ManifestMCPErrorCode.TX_FAILED,
        `Invalid funds format: empty entry in "${fundsStr}". Expected format: <amount><denom>[,<amount><denom>...]`,
      );
    }
    return parseAmount(trimmed);
  });
}

/**
 * Validate that a string is valid JSON. Throws ManifestMCPError if parsing fails.
 */
function validateJson(jsonStr: string, fieldName: string): void {
  try {
    JSON.parse(jsonStr);
  } catch {
    throw new ManifestMCPError(
      ManifestMCPErrorCode.TX_FAILED,
      `Invalid JSON for ${fieldName}: "${jsonStr.length > 100 ? `${jsonStr.slice(0, 100)}...` : jsonStr}". Must be valid JSON.`,
    );
  }
}

const AccessType = cosmwasm.wasm.v1.AccessType;

/**
 * Parse instantiate permission from flag value.
 * Accepts: "everybody", "nobody", or comma-separated addresses.
 */
function parseInstantiatePermission(value: string): {
  permission: number;
  addresses: string[];
} {
  const lower = value.toLowerCase();
  if (lower === 'everybody') {
    return { permission: AccessType.ACCESS_TYPE_EVERYBODY, addresses: [] };
  }
  if (lower === 'nobody') {
    return { permission: AccessType.ACCESS_TYPE_NOBODY, addresses: [] };
  }
  // Treat as comma-separated addresses
  const addresses = value.split(',').map((a) => a.trim());
  for (const addr of addresses) {
    validateAddress(addr, 'instantiate permission address');
  }
  return {
    permission: AccessType.ACCESS_TYPE_ANY_OF_ADDRESSES,
    addresses,
  };
}

/**
 * Build messages for a wasm transaction subcommand (no signing/broadcasting).
 */
export function buildWasmMessages(
  senderAddress: string,
  subcommand: string,
  args: string[],
): BuiltMessages {
  validateArgsLength(args, 'wasm transaction');

  switch (subcommand) {
    case 'store-code': {
      const permFlag = extractFlag(
        args,
        '--instantiate-permission',
        'wasm store-code',
      );
      const memoFlag = extractFlag(args, '--memo', 'wasm store-code');
      const positionalArgs = filterConsumedArgs(args, [
        ...permFlag.consumedIndices,
        ...memoFlag.consumedIndices,
      ]);

      requireArgs(positionalArgs, 1, ['wasm_bytes_base64'], 'wasm store-code');
      const [wasmBase64] = positionalArgs;

      let wasmByteCode: Uint8Array;
      try {
        wasmByteCode = fromBase64(wasmBase64);
      } catch {
        throw new ManifestMCPError(
          ManifestMCPErrorCode.TX_FAILED,
          'Invalid base64 encoding for wasm bytes.',
        );
      }

      const instantiatePermission = permFlag.value
        ? parseInstantiatePermission(permFlag.value)
        : undefined;

      const memo = memoFlag.value ?? '';
      if (memo) validateMemo(memo);

      const msg = {
        typeUrl: '/cosmwasm.wasm.v1.MsgStoreCode',
        value: MsgStoreCode.fromPartial({
          sender: senderAddress,
          wasmByteCode,
          instantiatePermission,
        }),
      };

      return { messages: [msg], memo };
    }

    case 'instantiate': {
      const adminFlag = extractFlag(args, '--admin', 'wasm instantiate');
      const fundsFlag = extractFlag(args, '--funds', 'wasm instantiate');
      const memoFlag = extractFlag(args, '--memo', 'wasm instantiate');
      const positionalArgs = filterConsumedArgs(args, [
        ...adminFlag.consumedIndices,
        ...fundsFlag.consumedIndices,
        ...memoFlag.consumedIndices,
      ]);

      requireArgs(
        positionalArgs,
        3,
        ['code_id', 'json_msg', 'label'],
        'wasm instantiate',
      );
      const [codeIdStr, jsonMsg, label] = positionalArgs;
      const codeId = parseBigInt(codeIdStr, 'code_id');
      validateJson(jsonMsg, 'instantiate message');

      const admin = adminFlag.value ?? '';
      if (admin) validateAddress(admin, 'admin');
      const funds = fundsFlag.value ? parseFunds(fundsFlag.value) : [];
      const memo = memoFlag.value ?? '';
      if (memo) validateMemo(memo);

      const msg = {
        typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract',
        value: MsgInstantiateContract.fromPartial({
          sender: senderAddress,
          codeId,
          label,
          msg: toUtf8(jsonMsg),
          funds,
          admin,
        }),
      };

      return { messages: [msg], memo };
    }

    case 'instantiate2': {
      const adminFlag = extractFlag(args, '--admin', 'wasm instantiate2');
      const fundsFlag = extractFlag(args, '--funds', 'wasm instantiate2');
      const memoFlag = extractFlag(args, '--memo', 'wasm instantiate2');
      const positionalArgs = filterConsumedArgs(args, [
        ...adminFlag.consumedIndices,
        ...fundsFlag.consumedIndices,
        ...memoFlag.consumedIndices,
      ]);

      requireArgs(
        positionalArgs,
        4,
        ['code_id', 'json_msg', 'label', 'salt'],
        'wasm instantiate2',
      );
      const [codeIdStr, jsonMsg, label, salt] = positionalArgs;
      const codeId = parseBigInt(codeIdStr, 'code_id');
      validateJson(jsonMsg, 'instantiate2 message');

      const admin = adminFlag.value ?? '';
      if (admin) validateAddress(admin, 'admin');
      const funds = fundsFlag.value ? parseFunds(fundsFlag.value) : [];
      const memo = memoFlag.value ?? '';
      if (memo) validateMemo(memo);

      const msg = {
        typeUrl: '/cosmwasm.wasm.v1.MsgInstantiateContract2',
        value: MsgInstantiateContract2.fromPartial({
          sender: senderAddress,
          codeId,
          label,
          msg: toUtf8(jsonMsg),
          funds,
          admin,
          salt: toUtf8(salt),
          fixMsg: false,
        }),
      };

      return { messages: [msg], memo };
    }

    case 'execute': {
      const fundsFlag = extractFlag(args, '--funds', 'wasm execute');
      const memoFlag = extractFlag(args, '--memo', 'wasm execute');
      const positionalArgs = filterConsumedArgs(args, [
        ...fundsFlag.consumedIndices,
        ...memoFlag.consumedIndices,
      ]);

      requireArgs(
        positionalArgs,
        2,
        ['contract_address', 'json_msg'],
        'wasm execute',
      );
      const [contractAddress, jsonMessage] = positionalArgs;
      validateAddress(contractAddress, 'contract address');
      validateJson(jsonMessage, 'execute message');

      const funds = fundsFlag.value ? parseFunds(fundsFlag.value) : [];
      const memo = memoFlag.value ?? '';
      if (memo) validateMemo(memo);

      const msg = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: senderAddress,
          contract: contractAddress,
          msg: toUtf8(jsonMessage),
          funds,
        }),
      };

      return { messages: [msg], memo };
    }

    case 'migrate': {
      const memoFlag = extractFlag(args, '--memo', 'wasm migrate');
      const positionalArgs = filterConsumedArgs(args, memoFlag.consumedIndices);

      requireArgs(
        positionalArgs,
        3,
        ['contract_address', 'new_code_id', 'json_msg'],
        'wasm migrate',
      );
      const [contractAddress, newCodeIdStr, jsonMessage] = positionalArgs;
      validateAddress(contractAddress, 'contract address');
      const codeId = parseBigInt(newCodeIdStr, 'new_code_id');
      validateJson(jsonMessage, 'migrate message');

      const memo = memoFlag.value ?? '';
      if (memo) validateMemo(memo);

      const msg = {
        typeUrl: '/cosmwasm.wasm.v1.MsgMigrateContract',
        value: MsgMigrateContract.fromPartial({
          sender: senderAddress,
          contract: contractAddress,
          codeId,
          msg: toUtf8(jsonMessage),
        }),
      };

      return { messages: [msg], memo };
    }

    case 'update-admin': {
      const memoFlag = extractFlag(args, '--memo', 'wasm update-admin');
      const positionalArgs = filterConsumedArgs(args, memoFlag.consumedIndices);

      requireArgs(
        positionalArgs,
        2,
        ['contract_address', 'new_admin'],
        'wasm update-admin',
      );
      const [contractAddress, newAdmin] = positionalArgs;
      validateAddress(contractAddress, 'contract address');
      validateAddress(newAdmin, 'new admin');

      const memo = memoFlag.value ?? '';
      if (memo) validateMemo(memo);

      const msg = {
        typeUrl: '/cosmwasm.wasm.v1.MsgUpdateAdmin',
        value: MsgUpdateAdmin.fromPartial({
          sender: senderAddress,
          contract: contractAddress,
          newAdmin,
        }),
      };

      return { messages: [msg], memo };
    }

    case 'clear-admin': {
      const memoFlag = extractFlag(args, '--memo', 'wasm clear-admin');
      const positionalArgs = filterConsumedArgs(args, memoFlag.consumedIndices);

      requireArgs(positionalArgs, 1, ['contract_address'], 'wasm clear-admin');
      const [contractAddress] = positionalArgs;
      validateAddress(contractAddress, 'contract address');

      const memo = memoFlag.value ?? '';
      if (memo) validateMemo(memo);

      const msg = {
        typeUrl: '/cosmwasm.wasm.v1.MsgClearAdmin',
        value: MsgClearAdmin.fromPartial({
          sender: senderAddress,
          contract: contractAddress,
        }),
      };

      return { messages: [msg], memo };
    }

    default:
      throwUnsupportedSubcommand('tx', 'wasm', subcommand);
  }
}

/**
 * Route wasm transaction to appropriate handler
 */
export async function routeWasmTransaction(
  client: SigningStargateClient,
  senderAddress: string,
  subcommand: string,
  args: string[],
  waitForConfirmation: boolean,
  options?: TxOptions,
): Promise<CosmosTxResult> {
  const built = buildWasmMessages(senderAddress, subcommand, args);
  const fee = await buildGasFee(
    client,
    senderAddress,
    built.messages,
    options,
    built.memo,
  );
  const result = await client.signAndBroadcast(
    senderAddress,
    built.messages,
    fee,
    built.memo,
  );
  return buildTxResult(
    'wasm',
    built.canonicalSubcommand ?? subcommand,
    result,
    waitForConfirmation,
  );
}
